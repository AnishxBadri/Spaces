import { createHash } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  attribute,
  enrichmentRecord,
  entity,
  entitySpace,
  integration,
  pendingBlob,
  space,
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
import { PICTURE_MAX_BYTES } from '../../enrichment/picture'
import { EnrichmentSources } from '../../enrichment/sources'
import type { AskResult } from '../../enrichment/sources'
import { WebsiteReader } from '../../enrichment/website'
import type { FetchedPage } from '../../enrichment/website'
import { ModelCall } from '../ports/ai'
import { jsonRecord, jsonValue } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import { createAttributeProgram } from '../attributes/create'
import { setValues } from '../attributes/values'
import { updateAttributeProgram } from '../attributes/update'
import { clearPictureProgram, setPictureProgram } from '../entities/picture'
import { resolveEntity } from '../entities/resolve'
import { FactsLive } from '../ports/facts'
import { ReceiptsLive } from '../ports/receipts'
import { storage } from '../storage'
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

/** No AI model set up: the built-in Website is not in the order. */
const NoModel = Layer.mergeAll(
  Layer.succeed(
    WebsiteReader,
    WebsiteReader.of({
      fetch: () => Effect.die(new Error('no fetch expected')),
      extractRoute: () => Effect.succeed('unrouted'),
    }),
  ),
  Layer.succeed(
    ModelCall,
    ModelCall.of({ complete: () => Effect.die(new Error('no call expected')) }),
  ),
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
      Effect.provide(
        Layer.mergeAll(sourcesLayer(fixtures), EnqueueTest, NoModel),
      ),
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
      parked: null,
    })
    expect(await lines(co)).toHaveLength(1)
  })

  it('asks no outside source for a sensitive record, and says so on the line', async () => {
    const co = await company('Secret')
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, co))
    website.knows = { 'company.description': 'Hello' }
    apollo.knows = { 'company.founded_year': 2019 }
    const outcome = await run(co, [website, apollo])
    expect(website.requests).toEqual([])
    expect(apollo.requests).toEqual([])
    expect(outcome.ran).toBe(true)
    expect((await lines(co)).map((m) => m['line'])).toEqual([
      'Website skipped · sensitive · Apollo skipped · sensitive',
    ])
    expect(await valuesOf(co)).not.toHaveProperty('founded')
  })
})

describe('the record picture', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  /** A distinct PNG per test: the store is content-addressed and shared. */
  const png = (tag: string) =>
    new Uint8Array([...PNG, ...new TextEncoder().encode(tag)])
  const stored: Array<string> = []
  let served: Map<
    string,
    { contentType: string; bytes: Uint8Array } | 'too large'
  >
  let fetched: Array<{ url: string; maxBytes: number | undefined }>

  const reader = Layer.succeed(
    WebsiteReader,
    WebsiteReader.of({
      fetch: (url, caps) =>
        Effect.sync((): FetchedPage => {
          fetched.push({ url, maxBytes: caps?.maxBytes })
          const hit = served.get(url)
          if (hit === undefined)
            return { ok: false, reason: `Could not reach ${url}` }
          if (hit === 'too large')
            return {
              ok: false,
              reason: 'The page is larger than the limit.',
              tooLarge: true,
            }
          return { ok: true, url, ...hit }
        }),
      extractRoute: () => Effect.succeed('unrouted'),
    }),
  )

  const runPictured = (entityId: string, fixtures: ReadonlyArray<Fixture>) =>
    Effect.runPromise(
      runEnrichment(entityId, 'test').pipe(
        Effect.provide(
          Layer.mergeAll(
            sourcesLayer(fixtures),
            EnqueueTest,
            reader,
            Layer.succeed(
              ModelCall,
              ModelCall.of({
                complete: () => Effect.die(new Error('no call expected')),
              }),
            ),
          ),
        ),
      ),
    )

  const pictureOf = async (entityId: string) =>
    (
      await db
        .select({ sha: entity.pictureSha, held: entity.pictureHeld })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)

  beforeEach(() => {
    served = new Map()
    fetched = []
  })

  afterAll(async () => {
    for (const sha of stored) await storage().delete(sha)
  })

  it('fetches a logo answer once, stores one blob and sets the picture; a second answer changes nothing', async () => {
    const co = await company('Flent')
    const bytes = png('flent')
    served.set('https://flent.example/logo.png', {
      contentType: 'image/png',
      bytes,
    })
    website.knows = { 'company.logo': 'https://flent.example/logo.png' }

    const outcome = await runPictured(co, [website, apollo])
    expect(website.requests[0]?.keys).toContain('company.logo')
    expect(apollo.requests[0]?.keys ?? []).not.toContain('company.logo')
    expect(fetched).toEqual([
      { url: 'https://flent.example/logo.png', maxBytes: PICTURE_MAX_BYTES },
    ])
    expect(outcome).toMatchObject({ ran: true, picture: 'set' })
    const sha = createHash('sha256').update(bytes).digest('hex')
    stored.push(sha)
    expect(await pictureOf(co)).toEqual({ sha, held: false })
    expect(await storage().exists(sha)).toBe(true)
    expect(
      await db.select().from(pendingBlob).where(eq(pendingBlob.sha, sha)),
    ).toEqual([])
    expect((await lines(co)).map((m) => m.line)).toEqual([
      'Enriched · Website, Apollo · 0 fields · logo',
    ])
    const [receipt] = await runReceipts(co)
    expect(receipt.unlinked).toEqual([])
    expect(receipt.picture).toMatchObject({ outcome: 'set', sha })

    served.set('https://flent.example/other.png', {
      contentType: 'image/png',
      bytes: png('other'),
    })
    website.knows = { 'company.logo': 'https://flent.example/other.png' }
    website.answersAll = true
    fetched = []
    await runPictured(co, [website])
    expect(website.requests[1]?.keys ?? []).not.toContain('company.logo')
    expect(fetched).toEqual([])
    expect(await pictureOf(co)).toEqual({ sha, held: false })
  })

  it('sets nothing for a non-image or an oversize response, and says so on the run line', async () => {
    const co = await company('Vector')
    served.set('https://vector.example/logo.svg', {
      contentType: 'image/svg+xml',
      bytes: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
    })
    website.knows = { 'company.logo': 'https://vector.example/logo.svg' }
    expect(await runPictured(co, [website])).toMatchObject({
      picture: 'not an image',
    })
    expect(await pictureOf(co)).toEqual({ sha: null, held: false })

    const big = await company('Big')
    served.set('https://big.example/logo.png', 'too large')
    website.knows = { 'company.logo': 'https://big.example/logo.png' }
    await runPictured(big, [website])
    expect(await pictureOf(big)).toEqual({ sha: null, held: false })

    expect((await lines(co)).map((m) => m.line)).toEqual([
      'Enriched · Website · 0 fields · Logo skipped · not an image',
    ])
    expect((await lines(big)).map((m) => m.line)).toEqual([
      'Enriched · Website · 0 fields · Logo skipped · too large',
    ])
  })

  it('keeps a picture cleared by hand clear on the next enrichment', async () => {
    const co = await company('Cleared')
    await Effect.runPromise(clearPictureProgram(co))
    served.set('https://cleared.example/logo.png', {
      contentType: 'image/png',
      bytes: png('cleared'),
    })
    website.knows = { 'company.logo': 'https://cleared.example/logo.png' }
    website.answersAll = true
    await runPictured(co, [website])
    expect(website.requests[0]?.keys ?? []).not.toContain('company.logo')
    expect(fetched).toEqual([])
    expect(await pictureOf(co)).toEqual({ sha: null, held: true })
  })

  it('sets a picture by hand as held, refuses a non-image, and clears to held', async () => {
    const co = await company('By hand')
    const bytes = png('by-hand')
    const by = await aUser()
    const set = await Effect.runPromise(
      setPictureProgram({ entityId: co, bytes, contentType: 'image/png', by }),
    )
    stored.push(set.sha)
    expect(set.previous).toBeNull()
    expect(await pictureOf(co)).toEqual({ sha: set.sha, held: true })

    const refused = await Effect.runPromise(
      Effect.flip(
        setPictureProgram({
          entityId: co,
          bytes: new TextEncoder().encode('<html></html>'),
          contentType: 'text/html',
          by,
        }),
      ),
    )
    expect(refused._tag).toBe('PictureRefused')

    const cleared = await Effect.runPromise(clearPictureProgram(co))
    expect(cleared.previous).toBe(set.sha)
    expect(await pictureOf(co)).toEqual({ sha: null, held: true })
  })
})

/** One source's answers outside a run: its own button, applied at once. */
const answerAs = (
  row: Row,
  entityId: string,
  answers: { [key: string]: Json },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { receiptId } = yield* (yield* Receipts).store({
        entityId,
        raw: answers,
        creditsUsed: 1,
      })
      return yield* (yield* Facts).answer({ entityId, answers, receiptId })
    }).pipe(Effect.provide(ports(row))),
  )

const optionsOf = async (slug: string) =>
  (
    await db
      .select({ options: attribute.options })
      .from(attribute)
      .where(eq(attribute.slug, slug))
  ).map((r) => r.options.options?.map((o) => o.label) ?? [])

describe('the funding stage', () => {
  it('fills the option whose label Apollo’s wording matches exactly', async () => {
    const co = await company('Flent')
    await answerAs(apollo.row, co, { 'company.funding_stage': 'Series A' })
    expect((await valuesOf(co)).funding_stage).toBe('series_a')
  })

  it('fills nothing and adds no option for a wording no option carries', async () => {
    const co = await company('Odd round')
    const before = await optionsOf('funding_stage')
    await answerAs(apollo.row, co, { 'company.funding_stage': 'Series A1' })
    expect((await valuesOf(co)).funding_stage).toBeUndefined()
    expect(await optionsOf('funding_stage')).toEqual(before)
    const [receipt] = await runReceipts(co)
    expect(receipt.fields).toEqual([
      expect.objectContaining({
        key: 'company.funding_stage',
        value: 'Series A1',
        outcome: 'invalid',
      }),
    ])
  })
})

let spaces = 0
const aSpace = async (name: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  const slug = `s${String(++spaces)}`
  await db
    .insert(space)
    .values({ entityId: ent.id, parentId: null, slug, path: slug })
  return ent.id
}

const aPerson = async (name: string) =>
  (
    await resolveEntity({
      kind: 'person',
      name: `${name} ${++n}`,
      source: { class: 'manual' },
    })
  ).entityId

const companyRows = (name: string) =>
  db
    .select({ id: entity.id })
    .from(entity)
    .where(and(eq(entity.kind, 'company'), eq(entity.canonicalName, name)))

const addCards = () =>
  db
    .select({
      payload: suggestion.payload,
      proposedById: suggestion.proposedById,
    })
    .from(suggestion)
    .where(eq(suggestion.kind, 'add_record'))

describe('a person’s company', () => {
  it('links a company that exists, by its domain, only while the link is empty', async () => {
    const flent = (
      await resolveEntity({
        kind: 'company',
        name: 'Flent',
        keys: { domain: 'flent.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const coo = await aPerson('COO')
    await answerAs(apollo.row, coo, {
      'person.company': { name: 'Flent', domain: 'flent.example' },
    })
    expect((await valuesOf(coo)).companies).toEqual([flent])

    const elsewhere = await company('Keyhold')
    const held = await aPerson('Held')
    await setValues({
      entityId: held,
      patch: { companies: [elsewhere] },
      actor: { type: 'user', id: await aUser() },
    })
    await answerAs(apollo.row, held, {
      'person.company': { name: 'Flent', domain: 'flent.example' },
    })
    expect((await valuesOf(held)).companies).toEqual([elsewhere])
    expect(await cardsFor(held)).toEqual([])
  })

  it('proposes an unknown company as one add card in the person’s space, and makes no company', async () => {
    const proptech = await aSpace('Proptech')
    const coo = await aPerson('Second COO')
    await db.insert(entitySpace).values({ entityId: coo, spaceId: proptech })
    const keyhold = { name: 'Keyhold', domain: 'keyhold.example' }

    await answerAs(apollo.row, coo, { 'person.company': keyhold })
    await answerAs(apollo.row, coo, { 'person.company': keyhold })

    expect(await companyRows('Keyhold')).toEqual([])
    expect((await valuesOf(coo)).companies).toBeUndefined()
    const cards = (await addCards()).filter(
      (c) => jsonRecord(c.payload).domain === 'keyhold.example',
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      proposedById: apollo.row.id,
      payload: expect.objectContaining({
        spaceId: proptech,
        name: 'Keyhold',
        watchIds: [],
      }),
    })
  })

  it('proposes nothing for a person filed in no space, and says so in the receipt', async () => {
    const loner = await aPerson('Loner')
    await answerAs(apollo.row, loner, {
      'person.company': { name: 'Nowhere Co', domain: 'nowhere-co.example' },
    })
    const cards = (await addCards()).filter(
      (c) => jsonRecord(c.payload).domain === 'nowhere-co.example',
    )
    expect(cards).toEqual([])
    expect(await companyRows('Nowhere Co')).toEqual([])
    const [receipt] = await runReceipts(loner)
    expect(receipt.cards).toEqual([
      expect.objectContaining({
        domain: 'nowhere-co.example',
        spaceId: null,
        outcome: 'not filed in a space',
      }),
    ])
  })
})
