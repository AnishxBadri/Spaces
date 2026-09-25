import { createHash, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { count, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  chunk,
  document,
  entity,
  extractionCache,
  link,
  suggestion,
} from '@spaces/db/schema'
import { schemaFor } from '@spaces/core/ai/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { createAttributeProgram } from '#/lib/attributes/create'
import { resolveEntity } from '#/lib/entities/resolve'
import { deleteDocumentWithBlobGc } from '#/lib/server/shared'
import { storage } from '#/lib/storage'
import { extractionSchemaKey } from './extraction-cache'
import { registryFor, rejectProgram } from './propose'
import {
  READ_DECK_PURPOSE,
  readDeckMessage,
  readDeckProgram,
} from './read-deck'
import { setAiRouteProgram } from './route'
import { setEntitySensitiveProgram } from './sensitivity-for'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-74. The extraction cache under the deck reader, through an injected
 * model (`MockLanguageModelV4`, as `read-deck.test.ts`): the route, the
 * sensitivity read, the context, the validator, the suggestion row and the
 * cache table are all real. "One provider call" is `doGenerateCalls`, and
 * "no usage" is the `ai_usage` count.
 */

const USER = FIXTURE_ACTOR.id

type Answer = Record<
  string,
  { value: unknown; refs: Array<string>; confidence: number }
>

function mockModel(answer: () => Answer) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(answer()) }],
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
      }),
  })
}

async function routeExtract(model = 'claude-haiku-4-5') {
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'anthropic',
      model,
    }),
  )
}

/** Bytes in the store, and their digest — one blob. */
async function aBlob(tag: string): Promise<string> {
  const bytes = Buffer.from(`Deckco deck ${tag}\n`, 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'application/pdf' })
  return sha
}

async function aCompany(tag: string): Promise<string> {
  const company = await resolveEntity({
    kind: 'company',
    name: `Deckco ${tag}`,
    keys: { domain: `deckco-${tag}.example` },
    source: { class: 'manual' },
  })
  return company.entityId
}

/** One `document` row over `sha`, chunked and filed against `companyId`. */
async function deckRow(sha: string, companyId: string): Promise<string> {
  const tag = randomUUID().slice(0, 8)
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
    blobSha: sha,
    extractionStatus: 'done',
    extractedText: 'Deckco builds B2B cooling for edge DCs. Berlin. Seed.',
  })
  await db.insert(chunk).values(
    [
      'Deckco: liquid cooling for edge data centres.',
      'Business model: B2B, sold to operators.',
      'Raising a seed round. HQ Berlin.',
    ].map((text, idx) => ({
      entityId: docEnt.id,
      sourceKind: 'document' as const,
      idx,
      text,
    })),
  )
  await db.insert(link).values({
    fromEntityId: docEnt.id,
    toEntityId: companyId,
    relation: 'tagged_in',
    source: 'manual',
  })
  return docEnt.id
}

const ANSWER = (documentId: string): Answer => ({
  description: {
    value: 'Liquid cooling for edge data centres',
    refs: [`doc:${documentId}#0`],
    confidence: 0.9,
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

async function usageCount() {
  return (await db.select({ value: count() }).from(aiUsage)).at(0)?.value ?? 0
}

async function cacheRows(sha: string) {
  return db
    .select()
    .from(extractionCache)
    .where(eq(extractionCache.blobSha, sha))
}

const patchesOn = (entityId: string) =>
  db
    .select()
    .from(suggestion)
    .where(eq(suggestion.entityId, entityId))
    .orderBy(suggestion.createdAt)

const read = (documentId: string, model: MockLanguageModelV4) =>
  Effect.runPromise(readDeckProgram({ documentId, userId: USER, model }))

/** Reject every open suggestion on the record — the demo's "reject it". */
async function rejectAll(entityId: string) {
  for (const row of await patchesOn(entityId))
    if (row.status === 'open')
      await Effect.runPromise(rejectProgram(row.id, { type: 'user', id: USER }))
}

beforeEach(() => {
  enqueued.length = 0
})

describe('the extraction cache under the deck reader', () => {
  it('reads the same deck twice with one provider call and one ai_usage row, the second from the cache', async () => {
    await routeExtract()
    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(tag)
    const sha = await aBlob(tag)
    const documentId = await deckRow(sha, companyId)
    const model = mockModel(() => ANSWER(documentId))
    const usageBefore = await usageCount()

    await read(documentId, model)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(await usageCount()).toBe(usageBefore + 1)
    expect(await cacheRows(sha)).toHaveLength(1)
    const first = (await patchesOn(companyId)).at(0)
    expect(first?.rationale).not.toMatch(/cached/)

    await rejectAll(companyId)
    const again = await read(documentId, model)
    expect(again.suggestions).toHaveLength(1)
    // No second call, no second usage row.
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(await usageCount()).toBe(usageBefore + 1)

    const rows = await patchesOn(companyId)
    expect(rows).toHaveLength(2)
    const second = rows[1]
    expect(second.status).toBe('open')
    expect(second.rationale).toMatch(/cached/)
    expect(second.rationale).toMatch(/no provider call was made/)
    expect(second.payload).toEqual(first?.payload)
    expect(second.refs).toEqual(first?.refs)
  })

  it('extracts one blob filed on two records once — two document rows, one call', async () => {
    await routeExtract()
    const tag = randomUUID().slice(0, 8)
    const sha = await aBlob(tag)
    const onA = await aCompany(`a-${tag}`)
    const onB = await aCompany(`b-${tag}`)
    const docA = await deckRow(sha, onA)
    const docB = await deckRow(sha, onB)
    // The model only ever answers citing the document it was shown first.
    const model = mockModel(() => ANSWER(docA))
    const usageBefore = await usageCount()

    await read(docA, model)
    await read(docB, model)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(await usageCount()).toBe(usageBefore + 1)
    expect(await cacheRows(sha)).toHaveLength(1)

    const a = (await patchesOn(onA)).at(0)
    const b = (await patchesOn(onB)).at(0)
    expect(b?.rationale).toMatch(/cached/)
    expect(b?.payload).toMatchObject({
      funding_stage: { value: 'seed' },
      location: { value: 'Berlin' },
    })
    // Each document cites itself: the stored answer is blob-relative.
    expect(a?.refs).toContain(`doc:${docA}#2`)
    expect(b?.refs).toContain(`doc:${docB}#2`)
    expect(b?.refs.some((r) => r.includes(docA))).toBe(false)
  })

  it('re-asks when the lane is routed to another model, and hits when nothing changed', async () => {
    await routeExtract('claude-haiku-4-5')
    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(tag)
    const sha = await aBlob(tag)
    const documentId = await deckRow(sha, companyId)
    const model = mockModel(() => ANSWER(documentId))

    await read(documentId, model)
    expect(model.doGenerateCalls).toHaveLength(1)

    // Nothing changed: a hit.
    await rejectAll(companyId)
    await read(documentId, model)
    expect(model.doGenerateCalls).toHaveLength(1)

    // Re-routed: a miss, a call, and a second row beside the first.
    await rejectAll(companyId)
    await routeExtract('claude-sonnet-4-5')
    await read(documentId, model)
    expect(model.doGenerateCalls).toHaveLength(2)
    expect((await cacheRows(sha)).map((r) => r.modelId).sort()).toEqual([
      'anthropic:claude-haiku-4-5',
      'anthropic:claude-sonnet-4-5',
    ])
    expect((await patchesOn(companyId)).at(-1)?.rationale).not.toMatch(/cached/)

    // Routed back: the first model's answer is still there.
    await rejectAll(companyId)
    await routeExtract('claude-haiku-4-5')
    await read(documentId, model)
    expect(model.doGenerateCalls).toHaveLength(2)
  })

  it('derives schema_key from the compiled registry schema, so a new attribute on Companies misses', async () => {
    await routeExtract()
    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(tag)
    const sha = await aBlob(tag)
    const documentId = await deckRow(sha, companyId)
    const model = mockModel(() => ANSWER(documentId))

    const keyOf = async () =>
      extractionSchemaKey(
        READ_DECK_PURPOSE,
        schemaFor(await registryFor(db, companyId), 'company fields'),
      )
    const before = await keyOf()
    expect(await keyOf()).toBe(before)

    await read(documentId, model)
    expect((await cacheRows(sha)).map((r) => r.schemaKey)).toEqual([before])

    await Effect.runPromise(
      createAttributeProgram({
        objectKind: 'company',
        name: `Burn multiple ${tag}`,
        type: 'number',
        createdBy: USER,
      }),
    )
    const after = await keyOf()
    expect(after).not.toBe(before)

    await rejectAll(companyId)
    await read(documentId, model)
    // The stored answer was for a shape that no longer exists: re-asked.
    expect(model.doGenerateCalls).toHaveLength(2)
    expect((await cacheRows(sha)).map((r) => r.schemaKey).sort()).toEqual(
      [before, after].sort(),
    )
  })

  it('is only a cache: truncating every row changes the cost and nothing else', async () => {
    await routeExtract()
    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(tag)
    const sha = await aBlob(tag)
    const documentId = await deckRow(sha, companyId)
    const model = mockModel(() => ANSWER(documentId))

    const cold = await read(documentId, model)
    await rejectAll(companyId)
    const warm = await read(documentId, model)
    expect(model.doGenerateCalls).toHaveLength(1)

    await db.execute(sql`truncate table ${extractionCache}`)
    expect(await db.select().from(extractionCache)).toEqual([])

    await rejectAll(companyId)
    const usageBefore = await usageCount()
    const truncated = await read(documentId, model)
    // The cost came back — one call, one usage row …
    expect(model.doGenerateCalls).toHaveLength(2)
    expect(await usageCount()).toBe(usageBefore + 1)
    // … and the behaviour never left: the same suggestion, field for field.
    const [c, w, t] = await patchesOn(companyId)
    for (const row of [w, t]) {
      expect(row.payload).toEqual(c.payload)
      expect(row.refs).toEqual(c.refs)
      expect(row.kind).toBe(c.kind)
    }
    for (const r of [cold, warm, truncated]) expect(r.skipped).toEqual([])
    // And the table refilled itself.
    expect(await cacheRows(sha)).toHaveLength(1)
  })

  it('still refuses a record that turned sensitive, even with its answer on disk', async () => {
    await routeExtract()
    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(tag)
    const sha = await aBlob(tag)
    const documentId = await deckRow(sha, companyId)
    const model = mockModel(() => ANSWER(documentId))
    await read(documentId, model)
    await rejectAll(companyId)

    await Effect.runPromise(setEntitySensitiveProgram(companyId, true))
    const failure = await Effect.runPromise(
      Effect.flip(readDeckProgram({ documentId, userId: USER, model })),
    )
    // The sensitive lane is not routed here, so the refusal is the route's —
    // the same one an empty cache would give.
    expect(readDeckMessage(failure)).toBe(
      'No model is routed for the extract lane at sensitive scope',
    )
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(
      (await patchesOn(companyId)).filter((r) => r.status === 'open'),
    ).toEqual([])
  })

  it('drops cached answers with their blob: the last document row deleted leaves none behind', async () => {
    await routeExtract()
    const tag = randomUUID().slice(0, 8)
    const sha = await aBlob(tag)
    const companyId = await aCompany(tag)
    const first = await deckRow(sha, companyId)
    const second = await deckRow(sha, await aCompany(`b-${tag}`))
    await read(
      first,
      mockModel(() => ANSWER(first)),
    )
    expect(await cacheRows(sha)).toHaveLength(1)

    // One row still names the bytes: the bytes and their answers stay.
    await deleteDocumentWithBlobGc(first)
    expect(await storage().exists(sha)).toBe(true)
    expect(await cacheRows(sha)).toHaveLength(1)

    // The last one goes, and takes both with it.
    await deleteDocumentWithBlobGc(second)
    expect(await storage().exists(sha)).toBe(false)
    expect(await cacheRows(sha)).toEqual([])
  })
})
