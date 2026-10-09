import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  enrichmentRecord,
  entity,
  integration,
  suggestion,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { user } from '@spaces/db/schema/auth'
import { workspace } from '@spaces/db/schema/workspace'
import type { Json } from '@spaces/db/json'
import {
  Facts,
  JobPermanent,
  Receipts,
  defineManifest,
  toManifestJson,
} from '@spaces/sdk'
import { EnrichmentSources } from '../../enrichment/sources'
import type { AskResult } from '../../enrichment/sources'
import { jsonRecord, jsonValue } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import { createAttributeProgram } from '../attributes/create'
import { setValues } from '../attributes/values'
import { updateAttributeProgram } from '../attributes/update'
import { resolveEntity } from '../entities/resolve'
import { FactsLive } from '../ports/facts'
import { ReceiptsLive } from '../ports/receipts'
import { ENRICHMENT_CAPABILITY } from './apply'
import { runEnrichment } from './run'

/**
 * The enrichment run against a real database, with two fixture sources —
 * Website and Apollo — that answer through the live Facts and Receipts
 * ports and log what they were asked. (D76)
 */

const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

type Row = { readonly id: string; readonly capabilityId: string }

const ports = (row: Row) =>
  Layer.mergeAll(
    FactsLive(row).pipe(Layer.provide(EnqueueTest)),
    ReceiptsLive(row),
  )

const manifestFor = (id: string, name: string) =>
  jsonRecord(
    jsonValue.parse(
      toManifestJson(
        defineManifest({
          manifestVersion: 1,
          id,
          version: '0.1.0',
          sdk: '^1.3',
          name,
          description: `${name} enrichment.`,
          settings: z.object({}),
          jobs: {
            enrichCompany: { trigger: 'action', uses: ['Facts', 'Receipts'] },
          },
          actions: [
            {
              id: 'enrich-company',
              label: 'Enrich',
              on: 'company',
              job: 'enrichCompany',
            },
          ],
        }),
      ),
    ),
  )

type Fixture = {
  readonly row: Row
  /** What the source knows, by vocabulary key. */
  knows: { [key: string]: Json }
  /** Answer every key it knows, asked or not (Apollo's shape). */
  answersAll: boolean
  credits: number
  asOf?: string
  readonly requests: Array<{ entityId: string; keys: Array<string> }>
}

const installSource = async (id: string, name: string): Promise<Fixture> => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: id,
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        manifest: manifestFor(id, name),
      })
      .returning({ id: integration.id, capabilityId: integration.capabilityId })
  ).at(0)
  if (!row) throw new Error('no row')
  return { row, knows: {}, answersAll: false, credits: 0, requests: [] }
}

const sourcesLayer = (fixtures: ReadonlyArray<Fixture>) =>
  Layer.succeed(
    EnrichmentSources,
    EnrichmentSources.of({
      ask: (integrationId, input) => {
        const f = fixtures.find((x) => x.row.id === integrationId)
        if (f === undefined)
          return Effect.succeed<AskResult>({ asked: false, reason: 'unknown' })
        f.requests.push({ entityId: input.entityId, keys: [...input.keys] })
        const answers = Object.fromEntries(
          Object.entries(f.knows).filter(
            ([key]) => f.answersAll || input.keys.includes(key),
          ),
        )
        return Effect.gen(function* () {
          const { receiptId } = yield* (yield* Receipts).store({
            entityId: input.entityId,
            raw: answers,
            creditsUsed: f.credits,
          })
          if (Object.keys(answers).length > 0)
            yield* (yield* Facts).answer({
              entityId: input.entityId,
              answers,
              receiptId,
              ...(f.asOf === undefined ? {} : { asOf: f.asOf }),
            })
          const asked: AskResult = { asked: true }
          return asked
        }).pipe(Effect.provide(ports(f.row)))
      },
    }),
  )

const run = (entityId: string, fixtures: ReadonlyArray<Fixture>) =>
  Effect.runPromise(
    runEnrichment(entityId, 'test').pipe(
      Effect.provide(Layer.merge(sourcesLayer(fixtures), EnqueueTest)),
    ),
  )

const setOrder = async (sources: ReadonlyArray<Fixture>) => {
  const settings = { enrichment: { sources: sources.map((s) => s.row.id) } }
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

let n = 0
const company = async (name: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name: `${name} ${++n}`,
      source: { class: 'manual' },
    })
  ).entityId

const valuesOf = async (entityId: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)?.values ?? {}

const aUser = async () => {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('no fixture user')
  return row.id
}

const runReceipts = async (entityId: string) =>
  (
    await db
      .select({
        raw: enrichmentRecord.raw,
        provider: enrichmentRecord.provider,
      })
      .from(enrichmentRecord)
      .where(
        and(
          eq(enrichmentRecord.entityId, entityId),
          eq(enrichmentRecord.provider, ENRICHMENT_CAPABILITY),
        ),
      )
  ).map((r) => jsonRecord(r.raw))

const lines = async (entityId: string) =>
  (
    await db
      .select({ verb: activity.verb, meta: activity.meta })
      .from(activity)
      .where(
        and(
          eq(activity.subjectEntityId, entityId),
          eq(activity.verb, 'entity.enriched'),
        ),
      )
  ).map((r) => r.meta)

const cardsFor = (entityId: string) =>
  db
    .select({ payload: suggestion.payload, kind: suggestion.kind })
    .from(suggestion)
    .where(eq(suggestion.entityId, entityId))

let employees: { id: string; slug: string }
let website: Fixture
let apollo: Fixture

// The harness isolates files, not tests: each test installs its own sources
// and names them as the workspace's order.
beforeEach(async () => {
  website = await installSource('website', 'Website')
  apollo = await installSource('apollo', 'Apollo')
  await setOrder([website, apollo])
})

beforeAll(async () => {
  employees = await Effect.runPromise(
    createAttributeProgram({
      objectKind: 'company',
      name: 'Employees',
      type: 'number',
      createdBy: await aUser(),
    }),
  )
  await Effect.runPromise(
    updateAttributeProgram({
      id: employees.id,
      config: { enrichmentKey: 'company.headcount' },
    }),
  )
})

describe('the link on the attribute', () => {
  it('is validated like any option: the key, its kind and the type that holds it', async () => {
    const text = await Effect.runPromise(
      createAttributeProgram({
        objectKind: 'company',
        name: 'Head note',
        type: 'text',
        createdBy: await aUser(),
      }),
    )
    const refused = (key: string) =>
      Effect.runPromise(
        Effect.flip(
          updateAttributeProgram({
            id: text.id,
            config: { enrichmentKey: key },
          }),
        ),
      )
    expect((await refused('company.mood')).message).toContain(
      'company.mood is not in the enrichment vocabulary',
    )
    expect((await refused('person.title')).message).toContain(
      'person.title describes a person',
    )
    expect((await refused('company.headcount')).message).toContain(
      'a text attribute cannot hold company.headcount',
    )
  })
})

describe('Facts.answer', () => {
  it('refuses a key outside the vocabulary, naming it, and writes nothing', async () => {
    const co = await company('Mood Co')
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { receiptId } = yield* (yield* Receipts).store({
          entityId: co,
          raw: {},
        })
        return yield* (yield* Facts).answer({
          entityId: co,
          answers: { 'company.description': 'Fine', 'company.mood': 'sunny' },
          receiptId,
        })
      }).pipe(Effect.provide(ports(apollo.row))),
    )
    if (Exit.isSuccess(exit)) throw new Error('answered')
    const error = Cause.squash(exit.cause)
    if (!(error instanceof JobPermanent)) throw new Error(String(error))
    expect(error.reason).toBe(
      'Facts.answer: company.mood is not in the enrichment vocabulary',
    )
    expect((await valuesOf(co)).description).toBeUndefined()
  })

  it('outside a run applies at once as a run of one source, with its line', async () => {
    const co = await company('Button Co')
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { receiptId } = yield* (yield* Receipts).store({
          entityId: co,
          raw: {},
          creditsUsed: 1,
        })
        return yield* (yield* Facts).answer({
          entityId: co,
          answers: { 'company.founded_year': 2019, 'company.ticker': 'NWR' },
          receiptId,
        })
      }).pipe(Effect.provide(ports(apollo.row))),
    )
    expect(result).toEqual({
      linked: ['company.founded_year'],
      unlinked: ['company.ticker'],
    })
    expect((await valuesOf(co)).founded_year).toBe(2019)
    expect((await lines(co)).map((m) => m.line)).toEqual([
      'Enriched · Apollo · 1 field · 1 credit',
    ])
  })
})

describe('enrichment.run', () => {
  it('fills a custom attribute linked to headcount; an unlinked answer writes nothing and stays in the receipt', async () => {
    const co = await company('Northwind')
    apollo.knows = { 'company.headcount': 120, 'company.industry': 'Robotics' }
    apollo.answersAll = true
    apollo.credits = 1

    const outcome = await run(co, [website, apollo])
    expect(outcome).toMatchObject({ ran: true, fields: 1, credits: 1 })

    const values = await valuesOf(co)
    expect(values[employees.slug]).toBe(120)
    expect(Object.values(values)).not.toContain('Robotics')
    const [receipt] = await runReceipts(co)
    expect(receipt.unlinked).toEqual([
      expect.objectContaining({
        key: 'company.industry',
        value: 'Robotics',
        integrationId: apollo.row.id,
      }),
    ])
  })

  it('asks in order: the first answer wins and the second source is asked only for keys still empty', async () => {
    const co = await company('Ordered')
    website.knows = {
      'company.description': 'From the website',
      'company.location': 'Pune, India',
    }
    apollo.knows = {
      'company.description': 'From Apollo',
      'company.headcount': 120,
      'company.founded_year': 2019,
    }
    apollo.credits = 1

    await run(co, [website, apollo])

    expect(website.requests).toHaveLength(1)
    expect(apollo.requests).toHaveLength(1)
    const askedApollo = apollo.requests[0]?.keys ?? []
    expect(askedApollo).not.toContain('company.description')
    expect(askedApollo).not.toContain('company.location')
    expect(askedApollo).toEqual(
      expect.arrayContaining([
        'company.headcount',
        'company.founded_year',
        'company.linkedin',
      ]),
    )
    const values = await valuesOf(co)
    expect(values.description).toBe('From the website')
    expect(values[employees.slug]).toBe(120)
    expect(values.founded_year).toBe(2019)

    const run1 = await lines(co)
    expect(run1).toHaveLength(1)
    expect(run1[0]?.line).toBe(
      'Enriched · Website, Apollo · 4 fields · 1 credit',
    )
  })

  it('keeps a disagreement between two sources in the receipt and raises no card', async () => {
    const co = await company('Two views')
    website.knows = { 'company.description': 'From the website' }
    apollo.knows = { 'company.description': 'From Apollo' }
    apollo.answersAll = true

    await run(co, [website, apollo])

    expect((await valuesOf(co)).description).toBe('From the website')
    expect(await cardsFor(co)).toEqual([])
    const [receipt] = await runReceipts(co)
    expect(receipt.losers).toEqual([
      expect.objectContaining({
        key: 'company.description',
        value: 'From Apollo',
        integrationId: apollo.row.id,
      }),
    ])
  })

  it('raises exactly one card for the record listing every field a person holds differently', async () => {
    const co = await company('Held')
    await setValues({
      entityId: co,
      patch: { description: 'Ours', location: 'Mumbai' },
      actor: { type: 'user', id: await aUser() },
    })
    apollo.knows = {
      'company.description': 'Theirs',
      'company.location': 'Pune, India',
      'company.founded_year': 2019,
    }
    apollo.answersAll = true

    await run(co, [apollo])

    const values = await valuesOf(co)
    expect(values.description).toBe('Ours')
    expect(values.location).toBe('Mumbai')
    expect(values.founded_year).toBe(2019)
    const cards = await cardsFor(co)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.kind).toBe('attribute_patch')
    expect(Object.keys(jsonRecord(cards[0]?.payload)).sort()).toEqual([
      'description',
      'location',
    ])
  })

  it('replaces a changing figure an integration set with a newer one, keeping the old in the receipt; an older one stands', async () => {
    const co = await company('Growing')
    apollo.knows = { 'company.headcount': 100 }
    await run(co, [apollo])
    expect((await valuesOf(co))[employees.slug]).toBe(100)

    website.knows = { 'company.headcount': 150 }
    await run(co, [website])
    expect((await valuesOf(co))[employees.slug]).toBe(150)
    const receipts = await runReceipts(co)
    const replaced = receipts
      .flatMap((r) => (Array.isArray(r.fields) ? r.fields : []))
      .map((f) => jsonRecord(f))
      .find((f) => f.outcome === 'replaced')
    expect(replaced).toMatchObject({
      value: 150,
      previous: { value: 100, integrationId: apollo.row.id },
    })
    expect(jsonRecord(replaced?.previous).at).toEqual(expect.any(String))

    apollo.knows = { 'company.headcount': 90 }
    apollo.asOf = '2020-01-01T00:00:00.000Z'
    await run(co, [apollo])
    expect((await valuesOf(co))[employees.slug]).toBe(150)
    expect(await cardsFor(co)).toEqual([])
  })

  it('turns a newer figure against a person’s value into a card, never a write', async () => {
    const co = await company('Counted')
    await setValues({
      entityId: co,
      patch: { [employees.slug]: 80 },
      actor: { type: 'user', id: await aUser() },
    })
    apollo.knows = { 'company.headcount': 150 }
    apollo.answersAll = true

    await run(co, [apollo])

    expect((await valuesOf(co))[employees.slug]).toBe(80)
    const cards = await cardsFor(co)
    expect(cards).toHaveLength(1)
    expect(Object.keys(jsonRecord(cards[0]?.payload))).toEqual([employees.slug])
  })

  it('writes one timeline line per run and none when nothing is asked', async () => {
    const co = await company('Quiet')
    website.knows = { 'company.description': 'Hello' }
    await run(co, [website, apollo])
    expect(await lines(co)).toHaveLength(1)

    await setOrder([])
    expect(await run(co, [])).toEqual({
      ran: false,
      reason: 'no source to ask',
    })
    expect(await lines(co)).toHaveLength(1)
  })
})
