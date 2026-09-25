import { Effect } from 'effect'
import { MockEmbeddingModelV4 } from 'ai/test'
import { asc, count, eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  chunk,
  credential,
  document,
  entity,
  workspace,
} from '@spaces/db/schema'
import type { WorkspaceSettings } from '@spaces/db/schema/workspace'
import { nextUtcMidnight } from '@spaces/core/ai/caps'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { searchAllProgram } from '#/lib/search/query'
import { clearQueryEmbeddingCache } from '#/lib/search/query-embedding'
import {
  EMBED_BACKFILL_KEY,
  embedBackfillStatusProgram,
  startEmbedBackfillProgram,
} from '#/lib/ai/embed-backfill'
import { EMBED_BATCH } from '#/lib/ai/embed-chunks'
import {
  pinEmbeddingProgram,
  readEmbeddingPinProgram,
} from '#/lib/ai/embedding-pin'
import { saveEmbeddingKeyProgram } from '#/lib/ai/providers/embed/settings'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { storeCredential } from '#/lib/vault'
import { fakeOllama } from '#/test/fake-ollama'
import { RESUME_SLACK_MS, runEmbedBackfill } from './embed-backfill'

/**
 * SPA-136, the corpus backfill, against Postgres. The embedding wire is a
 * counting fake (`MockEmbeddingModelV4` through `embed()`'s `model` seam),
 * so the pin, the live sensitivity check, the shared AI cap and the
 * `ai_usage` row are all real and every provider call is counted; `fetch`
 * throws, so a call that reached for the network would fail the test. The
 * queue is the stub, which records every send and refuses a second one
 * with the same key as the `exclusive` policy does.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const SMALL = 'text-embedding-3-small'
const LARGE = 'text-embedding-3-large'
const QUERY = 'heat rejection in racks'

/** A 768-wide vector pointing along `axis`. */
function toward(axis: number) {
  const v = Array.from({ length: PIN_DIMS }, () => 0)
  v[axis] = 1
  return v
}

/** The fake provider: records every batch; the query lands on axis 0. */
function countingModel(tokensPerCall = 10) {
  const calls: Array<ReadonlyArray<string>> = []
  const model = new MockEmbeddingModelV4({
    provider: 'mock',
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => {
      calls.push(values)
      return {
        embeddings: values.map((v) => (v === QUERY ? toward(0) : toward(700))),
        usage: { tokens: tokensPerCall },
        warnings: [],
      }
    },
  })
  return { model, calls }
}

async function setSettings(settings: WorkspaceSettings) {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

async function pinTo(model: string) {
  const r = await Effect.runPromise(
    pinEmbeddingProgram({ provider: 'openai', model }),
  )
  return r
}

async function newDeck(name: string, text = name) {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(document).values({
    entityId: row.id,
    filename: name,
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: text,
    tsv: sql`to_tsvector('english', ${text})`,
  })
  return row.id
}

/** `n` chunks on one deck, as SPA-121 writes them with no pin: no vectors. */
async function unembeddedChunks(entityId: string, n: number, from = 0) {
  const rows = Array.from({ length: n }, (_, i) => ({
    entityId,
    sourceKind: 'document' as const,
    sourceKey: '',
    idx: from + i,
    text: `Chunk ${String(from + i).padStart(4, '0')} of the corpus.`,
  }))
  if (rows.length > 0) await db.insert(chunk).values(rows)
}

async function chunkRows() {
  return db
    .select({
      idx: chunk.idx,
      text: chunk.text,
      model: chunk.embeddingModel,
      embedding: chunk.embedding,
    })
    .from(chunk)
    .orderBy(asc(chunk.idx))
}

async function usageRows() {
  const rows = await db.select({ value: count() }).from(aiUsage)
  return rows.at(0)?.value ?? 0
}

const status = () => Effect.runPromise(embedBackfillStatusProgram())

let fetches = 0

beforeEach(async () => {
  await setSettings({})
  await db.delete(chunk).where(isNotNull(chunk.id))
  await db.delete(aiUsage).where(isNotNull(aiUsage.id))
  await db.delete(credential).where(isNotNull(credential.id))
  await Effect.runPromise(
    saveEmbeddingKeyProgram(FIXTURE_ACTOR.id, {
      provider: 'openai',
      key: 'sk-embed-test-0000',
    }),
  )
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
  clearQueryEmbeddingCache()
  fetches = 0
  vi.stubGlobal('fetch', () => {
    fetches += 1
    throw new Error('the backfill reached for the network')
  })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the pre-flight estimate', () => {
  it('counts what is pending and prices it from the database alone — no provider call, no usage row', async () => {
    await pinTo(SMALL)
    const deck = await newDeck('Corpus.pdf')
    await unembeddedChunks(deck, 10)
    const { calls } = countingModel()

    const view = await status()
    if (view.pin === null) throw new Error('expected a pin')
    const chars = (await chunkRows()).reduce((n, r) => n + r.text.length, 0)
    expect(view).toMatchObject({
      total: 10,
      embedded: 0,
      estimate: {
        chunks: 10,
        tokens: Math.ceil(chars / 4),
        // 10 chunks × ~8 tokens at $0.02 per million is a fraction of a cent.
        cost: 'under $0.01',
      },
      run: { state: 'idle' },
    })

    expect(calls).toHaveLength(0)
    expect(fetches).toBe(0)
    expect(await usageRows()).toBe(0)
  })

  it('confirming enqueues one keyed run and still calls no provider; a second press is refused by the key', async () => {
    await pinTo(SMALL)
    await unembeddedChunks(await newDeck('Corpus.pdf'), 3)
    const { enqueued } = await import('#/test/queue-stub')

    expect(await Effect.runPromise(startEmbedBackfillProgram())).toEqual({
      status: 'queued',
    })
    expect(await Effect.runPromise(startEmbedBackfillProgram())).toEqual({
      status: 'already-queued',
    })
    expect(enqueued).toEqual([
      {
        name: QUEUES.embedBackfill,
        data: {},
        options: { singletonKey: EMBED_BACKFILL_KEY },
      },
    ])
    expect(await status()).toMatchObject({ run: { state: 'queued' } })
    expect(fetches).toBe(0)
    expect(await usageRows()).toBe(0)
  })

  it('refuses without a pin, and has nothing to do once every chunk carries it', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(startEmbedBackfillProgram()),
    )
    expect(failure).toMatchObject({
      _tag: 'BackfillRefused',
      message: 'Pin an embedding model before backfilling',
    })
    expect(await status()).toEqual({ pin: null })

    await pinTo(SMALL)
    expect(await Effect.runPromise(startEmbedBackfillProgram())).toEqual({
      status: 'nothing-to-do',
    })
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toHaveLength(0)
  })
})

describe('the run', () => {
  it('embeds every pending chunk in batches of EMBED_BATCH and stamps the pinned model', async () => {
    await pinTo(SMALL)
    await unembeddedChunks(await newDeck('Corpus.pdf'), EMBED_BATCH + 4)
    const { model, calls } = countingModel()

    await Effect.runPromise(runEmbedBackfill({}, { model }))

    expect(calls.map((c) => c.length)).toEqual([EMBED_BATCH, 4])
    const rows = await chunkRows()
    expect(rows.every((r) => r.model === SMALL)).toBe(true)
    expect(rows.every((r) => r.embedding?.length === PIN_DIMS)).toBe(true)
    expect(await status()).toMatchObject({
      total: EMBED_BATCH + 4,
      embedded: EMBED_BATCH + 4,
      estimate: { chunks: 0 },
    })
  })

  it('counts and embeds note and attribute chunks as well as document chunks', async () => {
    await pinTo(SMALL)
    await unembeddedChunks(await newDeck('Corpus.pdf'), 1)
    const noteId = (
      await db
        .insert(entity)
        .values({ kind: 'note', canonicalName: 'Site visit' })
        .returning({ id: entity.id })
    ).at(0)?.id
    const dealId = (
      await db
        .insert(entity)
        .values({ kind: 'deal', canonicalName: 'Coldplate seed' })
        .returning({ id: entity.id })
    ).at(0)?.id
    if (!noteId || !dealId) throw new Error('entity insert returned nothing')
    // SPA-132's two other sources, as `chunk.embed` writes them with no pin.
    await db.insert(chunk).values([
      {
        entityId: noteId,
        sourceKind: 'note',
        sourceKey: '',
        idx: 1,
        text: 'The hall runs warm-water cooling.',
      },
      {
        entityId: dealId,
        sourceKind: 'attribute',
        sourceKey: 'close_reason',
        idx: 2,
        text: 'Passed: the team was thin.',
      },
    ])

    expect(await status()).toMatchObject({ total: 3, estimate: { chunks: 3 } })
    const { model, calls } = countingModel()
    await Effect.runPromise(runEmbedBackfill({}, { model }))

    expect([...calls.flat()].sort()).toEqual(
      [
        'Chunk 0000 of the corpus.',
        'Passed: the team was thin.',
        'The hall runs warm-water cooling.',
      ].sort(),
    )
    expect((await chunkRows()).every((r) => r.model === SMALL)).toBe(true)
  })

  it('a re-queued run skips every chunk already carrying the pinned model', async () => {
    await pinTo(SMALL)
    const deck = await newDeck('Corpus.pdf')
    // What a run that died after one batch leaves: three chunks on the pin…
    await db.insert(chunk).values(
      [0, 1, 2].map((idx) => ({
        entityId: deck,
        sourceKind: 'document' as const,
        idx,
        text: `Done ${String(idx)}`,
        embedding: toward(5),
        embeddingModel: SMALL,
      })),
    )
    // …two never embedded, and one another model embedded.
    await unembeddedChunks(deck, 2, 3)
    await db.insert(chunk).values({
      entityId: deck,
      sourceKind: 'document',
      idx: 5,
      text: 'Stale 5',
      embedding: toward(6),
      embeddingModel: 'text-embedding-004',
    })
    const { model, calls } = countingModel()

    await Effect.runPromise(runEmbedBackfill({}, { model }))

    expect(calls).toHaveLength(1)
    expect([...(calls[0] ?? [])].sort()).toEqual(
      [
        'Chunk 0003 of the corpus.',
        'Chunk 0004 of the corpus.',
        'Stale 5',
      ].sort(),
    )
    const rows = await chunkRows()
    expect(rows.every((r) => r.model === SMALL)).toBe(true)
    // The done three kept the vectors they had.
    expect(rows.slice(0, 3).every((r) => r.embedding?.[5] === 1)).toBe(true)
  })

  it('sends nothing for a record that resolves sensitive now, whatever its chunks were stamped', async () => {
    await pinTo(SMALL)
    const open = await newDeck('Open.pdf')
    const secret = await newDeck('Secret.pdf')
    await unembeddedChunks(open, 1)
    await unembeddedChunks(secret, 1, 1)
    // The record turned sensitive after its chunks were stamped `false`.
    await db
      .update(entity)
      .set({ sensitive: true })
      .where(eq(entity.id, secret))
    const { model, calls } = countingModel()

    await Effect.runPromise(runEmbedBackfill({}, { model }))

    expect(calls.flat()).toEqual(['Chunk 0000 of the corpus.'])
    const rows = await chunkRows()
    expect(rows.map((r) => r.model)).toEqual([SMALL, null])
  })
})

describe('the AI cap', () => {
  it('stops the run mid-corpus with the embedded batches intact, and re-queues it for after the UTC reset', async () => {
    await pinTo(SMALL)
    await unembeddedChunks(await newDeck('Corpus.pdf'), EMBED_BATCH + 54)
    // One batch reports 100 tokens; the day allows 50, so the first call
    // runs (the check is before it) and the second is refused.
    await setSettings({
      ...(await db.select().from(workspace)).at(0)?.settings,
      ai_caps: { daily_tokens: 50 },
    })
    const { model, calls } = countingModel(100)

    const before = Date.now()
    const failure = await Effect.runPromise(
      Effect.flip(runEmbedBackfill({}, { model })),
    )
    expect(failure._tag).toBe('JobRateLimited')
    if (failure._tag !== 'JobRateLimited') throw new Error('unreachable')
    expect(failure.reason).toContain(`${String(EMBED_BATCH)} chunk(s) embedded`)
    expect(failure.reason).toContain("Today's AI cap of 50 tokens is reached")
    // Re-sent for the next UTC midnight, plus the slack.
    const resumeAt = before + failure.retryAfterMs
    const midnight = nextUtcMidnight(new Date(before)).getTime()
    expect(resumeAt).toBeGreaterThanOrEqual(midnight + RESUME_SLACK_MS - 5_000)
    expect(resumeAt).toBeLessThanOrEqual(midnight + RESUME_SLACK_MS + 5_000)

    expect(calls).toHaveLength(1)
    let rows = await chunkRows()
    expect(rows.filter((r) => r.model === SMALL)).toHaveLength(EMBED_BATCH)
    expect(rows.filter((r) => r.model === null)).toHaveLength(54)
    const firstBatch = new Set(calls[0])

    // The next day: yesterday's usage is outside the window.
    await db
      .update(aiUsage)
      .set({ at: sql`${aiUsage.at} - interval '1 day'` })
      .where(isNotNull(aiUsage.id))
    await Effect.runPromise(runEmbedBackfill({}, { model }))

    expect(calls).toHaveLength(2)
    expect(calls[1]).toHaveLength(54)
    expect(calls[1]?.some((t) => firstBatch.has(t))).toBe(false)
    rows = await chunkRows()
    expect(rows.every((r) => r.model === SMALL)).toBe(true)
  })

  it('sizes batches under the per-run cap instead of being refused by it', async () => {
    await pinTo(SMALL)
    await unembeddedChunks(await newDeck('Corpus.pdf'), 10)
    // Each chunk is 25 characters ≈ 7 tokens; a per-run cap of 20 tokens
    // is 80 characters, so three chunks fit a batch.
    await setSettings({
      ...(await db.select().from(workspace)).at(0)?.settings,
      ai_caps: { per_run_tokens: 20 },
    })
    const { model, calls } = countingModel()

    await Effect.runPromise(runEmbedBackfill({}, { model }))

    expect(calls.map((c) => c.length)).toEqual([3, 3, 3, 1])
    expect((await chunkRows()).every((r) => r.model === SMALL)).toBe(true)
  })
})

describe('a same-width model swap', () => {
  async function coolingDeck() {
    const deck = await newDeck(
      'Coldplate Series A.pdf',
      'Cold plates on every accelerator; the warm water leaves the hall.',
    )
    await db.insert(chunk).values({
      entityId: deck,
      sourceKind: 'document',
      idx: 0,
      text: 'Cold plates on every accelerator; the warm water leaves the hall.',
      embedding: toward(0),
      embeddingModel: SMALL,
    })
    return deck
  }

  const search = (model: MockEmbeddingModelV4) =>
    Effect.runPromise(
      searchAllProgram(
        { userId: FIXTURE_ACTOR.id, q: QUERY, semantic: true },
        { model },
      ),
    )

  it('is allowed, leaves every stored chunk stale so search excludes it at once, and offers the backfill without starting it', async () => {
    const first = await pinTo(SMALL)
    const deck = await coolingDeck()
    const { model } = countingModel()
    expect((await search(model)).find((h) => h.id === deck)).toMatchObject({
      matchedIn: 'semantic',
    })

    const swapped = await pinTo(LARGE)
    expect(swapped).toMatchObject({
      provider: 'openai',
      model: LARGE,
      dims: PIN_DIMS,
    })
    expect(swapped.pinnedAt >= first.pinnedAt).toBe(true)
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toEqual(swapped)

    // No column was written: the row still carries the old model's vector…
    const rows = await chunkRows()
    expect(rows.map((r) => r.model)).toEqual([SMALL])
    // …and the semantic lane, keyed on the pin, no longer reads it.
    clearQueryEmbeddingCache()
    expect((await search(model)).map((h) => h.id)).not.toContain(deck)

    // The backfill is offered — the estimate counts the stale chunk — and
    // nothing was queued.
    expect(await status()).toMatchObject({
      pin: { model: LARGE },
      total: 1,
      embedded: 0,
      estimate: { chunks: 1 },
      run: { state: 'idle' },
    })
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toHaveLength(0)
  })

  it('still refuses a change of width, and the pin stays', async () => {
    const first = await pinTo(SMALL)
    const failure = await Effect.runPromise(
      Effect.flip(
        pinEmbeddingProgram({
          provider: 'openai',
          model: 'text-embedding-ada-002',
        }),
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'PinLocked',
      message:
        'Embeddings are pinned to OpenAI text-embedding-3-small at 768 dimensions. text-embedding-ada-002 emits 1536; changing the width means altering the vector column and rebuilding its index, which this version cannot do yet.',
    })
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toEqual(first)
  })
})

describe('sensitive chunks and the slot (SPA-83)', () => {
  const SLOT_MODEL = 'nomic-embed-text'

  /** A sensitive deck with `n` chunks stamped sensitive and no vectors. */
  async function sensitiveDeck(n: number) {
    const deck = await newDeck('Vault memo.pdf')
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, deck))
    await db.insert(chunk).values(
      Array.from({ length: n }, (_, i) => ({
        entityId: deck,
        sourceKind: 'document' as const,
        sourceKey: '',
        idx: 100 + i,
        text: `Sensitive ${String(i)}`,
        sensitive: true,
      })),
    )
    return deck
  }

  /** The slot beside the pin, and Ollama saved as Providers saves it. */
  async function setSlot() {
    await storeCredential({
      scope: 'workspace',
      provider: 'ollama',
      kind: 'llm',
      secret: '',
      keyless: true,
      meta: { baseUrl: 'http://ollama:11434' },
      createdBy: FIXTURE_ACTOR.id,
    })
    const settings = (await db.select().from(workspace)).at(0)?.settings ?? {}
    const embedding = settings.embedding
    if (!embedding) throw new Error('expected a pin')
    await setSettings({
      ...settings,
      embedding: {
        ...embedding,
        sensitive: {
          provider: 'ollama',
          model: SLOT_MODEL,
          dims: PIN_DIMS,
          set_at: '2026-09-25T00:00:00.000Z',
        },
      },
    })
  }

  it('skips them before the slot, counts them priced "free — local model" after it, and the run embeds them through the slot', async () => {
    await pinTo(SMALL)
    await sensitiveDeck(3)
    // The normal half is already on the pin, so only the slot has work.
    await db.insert(chunk).values({
      entityId: await newDeck('Open.pdf'),
      sourceKind: 'document',
      sourceKey: '',
      idx: 0,
      text: 'Already embedded.',
      embedding: toward(4),
      embeddingModel: SMALL,
    })

    expect(await status()).toMatchObject({
      total: 1,
      embedded: 1,
      estimate: { chunks: 0 },
      sensitive: null,
    })
    expect(await Effect.runPromise(startEmbedBackfillProgram())).toEqual({
      status: 'nothing-to-do',
    })

    await setSlot()
    const chars = 'Sensitive 0'.length * 3
    expect(await status()).toMatchObject({
      estimate: { chunks: 0 },
      sensitive: {
        model: SLOT_MODEL,
        total: 3,
        embedded: 0,
        estimate: {
          chunks: 3,
          tokens: Math.ceil(chars / 4),
          cost: 'free — local model',
        },
      },
    })
    // Pricing read no provider and wrote no usage.
    expect(fetches).toBe(0)
    expect(await usageRows()).toBe(0)
    expect(await Effect.runPromise(startEmbedBackfillProgram())).toEqual({
      status: 'queued',
    })

    const ollama = fakeOllama({ pulled: [SLOT_MODEL] })
    vi.stubGlobal('fetch', ollama.fetch)
    await Effect.runPromise(runEmbedBackfill({}))

    expect(ollama.calls).toHaveLength(1)
    expect(ollama.calls[0]?.url).toBe('http://ollama:11434/api/embed')
    const rows = await db
      .select({ model: chunk.embeddingModel, embedding: chunk.embedding })
      .from(chunk)
      .where(eq(chunk.sensitive, true))
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.model === SLOT_MODEL)).toBe(true)
    expect(rows.every((r) => r.embedding?.length === PIN_DIMS)).toBe(true)
    expect(await status()).toMatchObject({
      sensitive: { total: 3, embedded: 3, estimate: { chunks: 0 } },
    })
  })
})
