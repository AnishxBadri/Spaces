import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, count, desc, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  attribute,
  document,
  documentChunk,
  entity,
  link,
  suggestion,
} from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { jsonRecord } from '#/lib/json'
import { objectIdForKindAsync } from '#/lib/attributes/objects'
import { resolveEntity } from '#/lib/entities/resolve'
import {
  enqueueReadDeckProgram,
  readDeckMessage,
  readDeckProgram,
  readDeckStatusProgram,
  statusOf,
} from './read-deck'
import { clearAiRouteProgram, setAiRouteProgram } from './route'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-90. The deck reader through an injected model (`MockLanguageModelV4`,
 * as `complete.test.ts`): the route, the sensitivity read, the context
 * assembly, the validator and the suggestion row are all real; nothing
 * reaches a network. Per-file truncation gives each file a clean database.
 */

const USER = FIXTURE_ACTOR.id

type Answer = Record<
  string,
  { value: unknown; refs: string[]; confidence: number }
>

/** A model that answers per call from `answer(prompt)`, or throws. */
function mockModel(answer: (prompt: string) => Answer | Error) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) => {
      const out = answer(JSON.stringify(options.prompt))
      if (out instanceof Error) return Promise.reject(out)
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(out) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      })
    },
  })
}

async function routeExtract() {
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

/** A company, and a deck filed against it with three chunks. */
async function deckOnCompany(opts: { chunks?: boolean } = {}) {
  const tag = randomUUID().slice(0, 8)
  const company = await resolveEntity({
    kind: 'company',
    name: `Deckco ${tag}`,
    keys: { domain: `deckco-${tag}.example` },
    source: { class: 'manual' },
  })
  const [docEnt] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: `deck-${tag}.pdf` })
    .returning({ id: entity.id })
  // Exempt from the one-writer rule: a fixture wanting a deck already
  // extracted, which is the state the button appears in.
  await db.insert(document).values({
    entityId: docEnt.id,
    filename: `deck-${tag}.pdf`,
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: 'Deckco builds B2B cooling for edge DCs. Berlin. Seed.',
  })
  if (opts.chunks !== false)
    await db
      .insert(documentChunk)
      .values(
        [
          'Deckco: liquid cooling for edge data centres.',
          'Business model: B2B, sold to operators.',
          'Raising a seed round. HQ Berlin.',
        ].map((text, idx) => ({ documentId: docEnt.id, idx, text })),
      )
  await db.insert(link).values({
    fromEntityId: docEnt.id,
    toEntityId: company.entityId,
    relation: 'tagged_in',
    source: 'manual',
  })
  return { companyId: company.entityId, documentId: docEnt.id, tag }
}

async function fileOnDeal(documentId: string, tag: string) {
  const [deal] = await db
    .insert(entity)
    .values({ kind: 'deal', canonicalName: `Deckco seed ${tag}` })
    .returning({ id: entity.id })
  await db.insert(link).values({
    fromEntityId: documentId,
    toEntityId: deal.id,
    relation: 'tagged_in',
    source: 'manual',
  })
  return deal.id
}

/** `ai_usage` accumulates across this file's tests; each asserts its delta. */
async function usageCount() {
  const [{ value }] = await db.select({ value: count() }).from(aiUsage)
  return value
}

const suggestionsOn = (entityId: string) =>
  db.select().from(suggestion).where(eq(suggestion.entityId, entityId))

const COMPANY_ANSWER = (documentId: string): Answer => ({
  description: {
    value: 'Liquid cooling for edge data centres',
    refs: [`doc:${documentId}#0`],
    confidence: 0.9,
  },
  business_model: {
    value: ['b2b'],
    refs: [`doc:${documentId}#1`],
    confidence: 0.8,
  },
  funding_stage: {
    value: 'seed',
    refs: [`doc:${documentId}#2`],
    confidence: 0.85,
  },
  location: {
    value: 'Berlin',
    refs: [`doc:${documentId}#2`],
    confidence: 0.7,
  },
})

beforeEach(() => {
  enqueued.length = 0
})

describe('readDeck', () => {
  it('writes one open attribute_patch on the filed company, with per-field refs and a rationale', async () => {
    await routeExtract()
    const { companyId, documentId } = await deckOnCompany()
    const model = mockModel(() => COMPANY_ANSWER(documentId))
    const usageBefore = await usageCount()

    const result = await Effect.runPromise(
      readDeckProgram({ documentId, userId: USER, model }),
    )
    expect(result.suggestions).toHaveLength(1)
    expect(model.doGenerateCalls).toHaveLength(1)

    // The deck's chunks lead the prompt, each under its own ref.
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain(`[doc:${documentId}#0]`)
    expect(prompt).toContain(`[doc:${documentId}#2]`)

    const rows = await suggestionsOn(companyId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('attribute_patch')
    expect(row.status).toBe('open')
    expect(row.proposedByType).toBe('user')
    expect(row.proposedById).toBe(USER)
    expect(row.payload).toMatchObject({
      funding_stage: { value: 'seed', refs: [`doc:${documentId}#2`] },
      business_model: { value: ['b2b'], refs: [`doc:${documentId}#1`] },
      location: { value: 'Berlin' },
      description: { refs: [`doc:${documentId}#0`] },
    })
    expect([...row.refs].sort()).toEqual(
      [0, 1, 2].map((i) => `doc:${documentId}#${String(i)}`),
    )
    expect(row.rationale).toMatch(/4 fields proposed/)

    // Proposing wrote no value, and the call is billed to who pressed.
    const company = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, companyId))
    ).at(0)
    expect(company?.values.funding_stage).toBeUndefined()
    const usage = await db
      .select()
      .from(aiUsage)
      .orderBy(desc(aiUsage.at))
      .limit(1)
    expect(await usageCount()).toBe(usageBefore + 1)
    expect(usage[0]).toMatchObject({
      lane: 'extract',
      callerType: 'user',
      callerId: USER,
    })
  })

  it('cites the document itself when it has no chunks yet', async () => {
    await routeExtract()
    const { companyId, documentId } = await deckOnCompany({ chunks: false })
    const model = mockModel(() => ({
      location: {
        value: 'Berlin',
        refs: [`doc:${documentId}#0`],
        confidence: 0.7,
      },
    }))
    await Effect.runPromise(
      readDeckProgram({ documentId, userId: USER, model }),
    )
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain(`[doc:${documentId}#0]`)
    expect(prompt).toContain('Deckco builds B2B cooling')
    const rows = await suggestionsOn(companyId)
    expect(rows[0].refs).toEqual([`doc:${documentId}#0`])
  })

  it('drops a field naming an archived option and counts it, without failing the run', async () => {
    await routeExtract()
    const { companyId, documentId } = await deckOnCompany()
    const companyObject = await objectIdForKindAsync('company')
    const where = and(
      eq(attribute.objectId, companyObject),
      eq(attribute.slug, 'funding_stage'),
    )
    const held = (
      await db
        .select({ options: attribute.options })
        .from(attribute)
        .where(where)
    ).at(0)
    if (!held) throw new Error('the seed has no funding_stage')
    const options = held.options.options ?? []
    await db
      .update(attribute)
      .set({
        options: {
          ...held.options,
          options: options.map((o) =>
            o.id === 'bootstrapped' ? { ...o, archived: true } : o,
          ),
        },
      })
      .where(where)

    const model = mockModel(() => ({
      funding_stage: {
        value: 'bootstrapped',
        refs: [`doc:${documentId}#2`],
        confidence: 0.6,
      },
      location: {
        value: 'Berlin',
        refs: [`doc:${documentId}#2`],
        confidence: 0.7,
      },
    }))
    const result = await Effect.runPromise(
      readDeckProgram({ documentId, userId: USER, model }),
    )
    expect(result.suggestions).toHaveLength(1)
    const row = (await suggestionsOn(companyId))[0]
    expect(Object.keys(jsonRecord(row.payload))).toEqual(['location'])
    expect(row.rationale).toMatch(/1 proposed field was dropped at validation/)
    expect(row.rationale).toMatch(/funding_stage/)
  })

  it('reads a deck filed on a company and a deal as two calls and two suggestions', async () => {
    await routeExtract()
    const { companyId, documentId, tag } = await deckOnCompany()
    const dealId = await fileOnDeal(documentId, tag)
    const model = mockModel((prompt) =>
      prompt.includes('about the deal')
        ? {
            stage: {
              value: 'screening',
              refs: [`doc:${documentId}#2`],
              confidence: 0.5,
            },
          }
        : COMPANY_ANSWER(documentId),
    )

    const usageBefore = await usageCount()
    const result = await Effect.runPromise(
      readDeckProgram({ documentId, userId: USER, model }),
    )
    expect(model.doGenerateCalls).toHaveLength(2)
    expect(result.suggestions).toHaveLength(2)
    expect(await usageCount()).toBe(usageBefore + 2)

    const onCompany = await suggestionsOn(companyId)
    const onDeal = await suggestionsOn(dealId)
    expect(onCompany).toHaveLength(1)
    expect(onDeal).toHaveLength(1)
    // Scoped to each registry, not merged.
    expect(Object.keys(jsonRecord(onDeal[0].payload))).toEqual(['stage'])
    expect(Object.keys(jsonRecord(onCompany[0].payload))).not.toContain('stage')
    for (const row of [onCompany[0], onDeal[0]])
      expect(row.rationale).toMatch(/2 model calls were made/)
  })

  it('turns the founders the deck names into identity suggestions on the deal, after its patch', async () => {
    // SPA-105: a claim on a person reference (`people`) is no longer held
    // back — each person becomes one `identity` row on the same record,
    // citing the field's refs, and nothing is resolved until accepted.
    await routeExtract()
    const { documentId, tag } = await deckOnCompany()
    const dealId = await fileOnDeal(documentId, tag)
    const model = mockModel((prompt) =>
      prompt.includes('about the deal')
        ? {
            stage: {
              value: 'screening',
              refs: [`doc:${documentId}#2`],
              confidence: 0.5,
            },
            people: {
              value: [
                {
                  name: 'Ada Founder',
                  role: 'CEO',
                  email: `ada-${tag}@deckco.example`,
                },
                { name: 'Bo Cofounder', role: 'CTO' },
              ],
              refs: [`doc:${documentId}#0`],
              confidence: 0.9,
            },
          }
        : COMPANY_ANSWER(documentId),
    )
    const entitiesBefore = (
      await db.select({ value: count() }).from(entity)
    ).at(0)?.value

    const result = await Effect.runPromise(
      readDeckProgram({ documentId, userId: USER, model }),
    )
    expect(result.suggestions).toHaveLength(4)

    const onDeal = await suggestionsOn(dealId)
    const patch = onDeal.filter((r) => r.kind === 'attribute_patch')
    const identities = onDeal.filter((r) => r.kind === 'identity')
    expect(patch).toHaveLength(1)
    // The claim is not a field of the patch, and not held back any more.
    expect(Object.keys(jsonRecord(patch[0].payload))).toEqual(['stage'])
    expect(patch[0].rationale).toMatch(/2 people named in the deck/)
    expect(patch[0].rationale).not.toMatch(/Held back/)

    expect(identities.map((r) => r.payload)).toEqual(
      expect.arrayContaining([
        {
          name: 'Ada Founder',
          role: 'CEO',
          email: `ada-${tag}@deckco.example`,
        },
        { name: 'Bo Cofounder', role: 'CTO' },
      ]),
    )
    for (const row of identities) {
      expect(row.status).toBe('open')
      expect(row.refs).toEqual([`doc:${documentId}#0`])
      expect(row.proposedById).toBe(USER)
      expect(row.rationale).toMatch(/Named in deck-/)
    }
    // Proposing resolved nobody.
    expect(
      (await db.select({ value: count() }).from(entity)).at(0)?.value,
    ).toBe(entitiesBefore)
  })

  it('fails with the provider’s words and writes no suggestion when the provider is unreachable', async () => {
    await routeExtract()
    const { companyId, documentId, tag } = await deckOnCompany()
    const dealId = await fileOnDeal(documentId, tag)
    // The company answers; the deal's call cannot reach the provider — so
    // the first read's suggestion must not have been written either.
    const model = mockModel((prompt) =>
      prompt.includes('about the deal')
        ? new Error('connect ECONNREFUSED 127.0.0.1:443')
        : COMPANY_ANSWER(documentId),
    )

    const failure = await Effect.runPromise(
      Effect.flip(readDeckProgram({ documentId, userId: USER, model })),
    )
    expect(failure._tag).toBe('ProviderCallFailed')
    expect(readDeckMessage(failure)).toContain('did not answer')
    expect(readDeckMessage(failure)).toContain('ECONNREFUSED')
    expect(await suggestionsOn(companyId)).toHaveLength(0)
    expect(await suggestionsOn(dealId)).toHaveLength(0)
  })

  it('fails permanently when the extract lane is not routed', async () => {
    await Effect.runPromise(clearAiRouteProgram('extract', 'normal'))
    const { companyId, documentId } = await deckOnCompany()
    const model = mockModel(() => ({}))
    const failure = await Effect.runPromise(
      Effect.flip(readDeckProgram({ documentId, userId: USER, model })),
    )
    expect(readDeckMessage(failure)).toBe(
      'No model is routed for the extract lane',
    )
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await suggestionsOn(companyId)).toHaveLength(0)
  })
})

describe('the Read deck trigger', () => {
  it('enqueues one job keyed on the document, and refuses a second press as already reading', async () => {
    const { documentId } = await deckOnCompany()
    const first = await Effect.runPromise(
      enqueueReadDeckProgram(documentId, USER),
    )
    expect(first).toEqual({ status: 'queued' })
    const second = await Effect.runPromise(
      enqueueReadDeckProgram(documentId, USER),
    )
    expect(second).toEqual({ status: 'already-reading' })

    expect(enqueued).toEqual([
      {
        name: QUEUES.readDeck,
        data: { documentId, userId: USER },
        options: { singletonKey: documentId },
      },
    ])
    const status = await Effect.runPromise(readDeckStatusProgram([documentId]))
    expect(status[documentId]).toEqual({ state: 'reading' })
  })

  it('refuses a deck whose text is not extracted', async () => {
    const { documentId } = await deckOnCompany()
    await db
      .update(document)
      .set({ extractionStatus: 'pending' })
      .where(eq(document.entityId, documentId))
    const failure = await Effect.runPromise(
      Effect.flip(enqueueReadDeckProgram(documentId, USER)),
    )
    expect(failure._tag).toBe('ReadDeckRefused')
    expect(enqueued).toHaveLength(0)
  })

  it('reads the latest job: reading, done, or failed with the job’s own sentence', () => {
    const at = (s: string) => new Date(s)
    expect(statusOf([])).toEqual({ state: 'idle' })
    expect(
      statusOf([
        {
          state: 'failed',
          output: { reason: 'old' },
          createdOn: at('2026-09-01'),
        },
        { state: 'active', output: null, createdOn: at('2026-09-02') },
      ]),
    ).toEqual({ state: 'reading' })
    expect(
      statusOf([
        {
          state: 'cancelled',
          output: { kind: 'permanent', reason: 'Anthropic did not answer: x' },
          createdOn: at('2026-09-03'),
        },
      ]),
    ).toMatchObject({ state: 'failed', message: 'Anthropic did not answer: x' })
    expect(
      statusOf([
        { state: 'completed', output: {}, createdOn: at('2026-09-03') },
      ]),
    ).toMatchObject({ state: 'done' })
  })
})
