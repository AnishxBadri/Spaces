import { createHash, randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { MockEmbeddingModelV4 } from 'ai/test'
import { and, asc, count, eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  chunk,
  document,
  entity,
  entitySpace,
  link,
  space,
  workspace,
} from '@spaces/db/schema'
import type {
  EmbeddingPinSetting,
  WorkspaceSettings,
} from '@spaces/db/schema/workspace'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { recordContextProgram } from '#/lib/context/record'
import { EMBED_BATCH } from '#/lib/ai/embed-document'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { storeCredential } from '#/lib/vault'
import { fakeOllama } from '#/test/fake-ollama'
import { JobContext, JobPermanent } from '../run-job'
import { ExtractionStore, extractDocument } from './extract-document'
import { embedDocument, runEmbedDocument } from './embed-document'

/**
 * SPA-121. `document.embed` against Postgres, with the embedding model
 * injected through `embed()`'s seam — the pin, the sensitivity refusal, the
 * width assertion and the `ai_usage` row are real; `fetch` is stubbed to
 * throw, so a call that tried the network would fail the test rather than
 * leave the box.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const PINNED_MODEL = 'text-embedding-3-small'

const vector = (width: number, seed: number): Array<number> =>
  Array.from({ length: width }, (_, i) =>
    Number((Math.sin(i * seed + seed) / 10).toFixed(6)),
  )

function mockModel(width: number) {
  return new MockEmbeddingModelV4({
    provider: 'mock',
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((_, i) => vector(width, i + 1)),
      usage: { tokens: values.length },
      warnings: [],
    }),
  })
}

async function setSettings(settings: WorkspaceSettings) {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

const PIN: EmbeddingPinSetting = {
  provider: 'openai',
  model: PINNED_MODEL,
  dims: PIN_DIMS,
  pinned_at: '2026-09-20T00:00:00.000Z',
}

/** `pages` marked pages, the shape `fromPdf` leaves (SPA-30). */
const deckText = (pages: number, word = 'orbital') =>
  Array.from(
    { length: pages },
    (_, i) => `[Page ${String(i + 1)}]\nPage ${String(i + 1)} ${word} traction`,
  ).join('\n\n')

async function mkDocument(filename: string, text: string): Promise<string> {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: filename })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('insert returned nothing')
  await db.insert(document).values({
    entityId: ent.id,
    filename,
    mime: 'application/pdf',
    kind: 'deck',
    extractedText: text,
    extractionStatus: 'done',
  })
  return ent.id
}

async function chunksOf(documentId: string) {
  return db
    .select({
      idx: chunk.idx,
      text: chunk.text,
      page: chunk.page,
      embedding: chunk.embedding,
      embeddingModel: chunk.embeddingModel,
      sensitive: chunk.sensitive,
      sourceKind: chunk.sourceKind,
      sourceKey: chunk.sourceKey,
    })
    .from(chunk)
    .where(eq(chunk.entityId, documentId))
    .orderBy(asc(chunk.idx))
}

const runJob = (documentId: string, model?: ReturnType<typeof mockModel>) =>
  Effect.runPromise(
    runEmbedDocument({ documentId }, model === undefined ? {} : { model }),
  )

beforeEach(async () => {
  await setSettings({})
  await db.delete(aiUsage).where(isNotNull(aiUsage.id))
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', () => {
    throw new Error('document.embed reached for the network')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('document.embed with no pin', () => {
  it('writes one chunk per page with a null embedding and a null embedding_model', async () => {
    const id = await mkDocument('deck.pdf', deckText(6))
    await runJob(id, mockModel(PIN_DIMS))

    const rows = await chunksOf(id)
    expect(rows).toHaveLength(6)
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2, 3, 4, 5])
    expect(rows.map((r) => r.page)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rows[4].text).toBe('[Page 5]\nPage 5 orbital traction')
    for (const r of rows) {
      expect(r.embedding).toBeNull()
      expect(r.embeddingModel).toBeNull()
      expect(r).toMatchObject({ sourceKind: 'document', sourceKey: '' })
    }
    // No pin, no call: nothing was billed.
    const [{ value }] = await db.select({ value: count() }).from(aiUsage)
    expect(value).toBe(0)
  })

  it('feeds the lexical lane: the Context readout cites "chunk 4"', async () => {
    const company = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: 'Vayu Orbital' })
        .returning({ id: entity.id })
    ).at(0)
    if (!company) throw new Error('insert returned nothing')
    const id = await mkDocument('deck.pdf', deckText(6))
    await db.insert(link).values({
      fromEntityId: id,
      toEntityId: company.id,
      relation: 'tagged_in',
      source: 'manual',
    })
    await runJob(id)

    const context = await Effect.runPromise(
      recordContextProgram({
        entityId: company.id,
        user: { id: FIXTURE_ACTOR.id },
        asOf: '2026-09-23T00:00:00Z',
        budgetChars: 20_000,
      }),
    )
    const fifth = context.items.find((i) => i.ref === `doc:${id}#4`)
    expect(fifth).toMatchObject({
      kind: 'doc_chunk',
      cite: 'deck.pdf · chunk 4',
    })
    expect(fifth?.text).toContain('Page 5 orbital traction')
  })
})

describe('document.embed with a pin', () => {
  it('stores 768-wide vectors under the pinned model', async () => {
    await setSettings({ embedding: PIN })
    const id = await mkDocument('deck.pdf', deckText(3))
    await runJob(id, mockModel(PIN_DIMS))

    const rows = await chunksOf(id)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.embeddingModel).toBe(PINNED_MODEL)
      expect(r.embedding).toHaveLength(768)
    }
    const usage = await db
      .select({ lane: aiUsage.lane, model: aiUsage.model })
      .from(aiUsage)
    expect(usage).toEqual([{ lane: 'embed', model: PINNED_MODEL }])
  })

  it('embeds in batches, every vector landing on its own chunk', async () => {
    await setSettings({ embedding: PIN })
    const pages = EMBED_BATCH + 4
    const id = await mkDocument('long.pdf', deckText(pages))
    const model = mockModel(PIN_DIMS)
    await runJob(id, model)

    expect(model.doEmbedCalls.map((c) => c.values.length)).toEqual([
      EMBED_BATCH,
      4,
    ])
    const rows = await chunksOf(id)
    expect(rows).toHaveLength(pages)
    // The mock answers vector(width, position-in-batch + 1): the first chunk
    // of the second batch carries seed 1 again, not seed EMBED_BATCH + 1.
    expect(rows[EMBED_BATCH].embedding).toEqual(vector(PIN_DIMS, 1))
    expect(rows[EMBED_BATCH + 3].embedding).toEqual(vector(PIN_DIMS, 4))
    const [{ value }] = await db.select({ value: count() }).from(aiUsage)
    expect(value).toBe(2)
  })

  it('a wrong-width answer writes the chunks without vectors and fails the job permanently', async () => {
    await setSettings({ embedding: PIN })
    const id = await mkDocument('deck.pdf', deckText(2))
    const failure = await Effect.runPromise(
      Effect.flip(
        runEmbedDocument({ documentId: id }, { model: mockModel(1536) }),
      ),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toContain('2 chunk(s) written without vectors')
    expect(failure.reason).toContain('returned 1536 dimensions')

    const rows = await chunksOf(id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.embedding === null)).toBe(true)
  })

  it('leaves a sensitive document unembedded, never sends it, and still chunks it', async () => {
    await setSettings({ embedding: PIN })
    const id = await mkDocument('deck.pdf', deckText(2))
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    const model = mockModel(PIN_DIMS)
    await runJob(id, model)

    const rows = await chunksOf(id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.embedding === null && r.sensitive)).toBe(true)
    expect(model.doEmbedCalls).toHaveLength(0)
  })
})

describe('document.embed stamps sensitive at write time', () => {
  async function mkSpace(name: string, sensitive: boolean) {
    const ent = (
      await db
        .insert(entity)
        .values({ kind: 'space', canonicalName: name, sensitive })
        .returning({ id: entity.id })
    ).at(0)
    if (!ent) throw new Error('insert returned nothing')
    const slug = `s${ent.id.replace(/-/g, '').slice(0, 12)}`
    await db.insert(space).values({ entityId: ent.id, slug, path: slug })
    return ent.id
  }

  it('from the space the document is filed in', async () => {
    const vault = await mkSpace('Board materials', true)
    const id = await mkDocument('board.pdf', deckText(2))
    await db
      .insert(entitySpace)
      .values({ entityId: id, spaceId: vault, source: 'manual' })
    await runJob(id)
    expect((await chunksOf(id)).map((r) => r.sensitive)).toEqual([true, true])
  })

  it('an unfiled document resolves to the workspace default rather than throwing', async () => {
    const id = await mkDocument('loose.pdf', deckText(2))
    await runJob(id)
    expect((await chunksOf(id)).map((r) => r.sensitive)).toEqual([false, false])

    await setSettings({ sensitivity_default: 'sensitive' })
    await runJob(id)
    expect((await chunksOf(id)).map((r) => r.sensitive)).toEqual([true, true])
  })
})

describe('re-extraction', () => {
  it('extraction enqueues document.embed, and a second pass replaces the chunks rather than duplicating them', async () => {
    const { enqueued } = await import('#/test/queue-stub')
    const first = new TextEncoder().encode(
      'Seed round.\n\nTraction is real.\n\nTeam of four.',
    )
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
    const ent = (
      await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: 'memo.txt' })
        .returning({ id: entity.id })
    ).at(0)
    if (!ent) throw new Error('insert returned nothing')
    const id = ent.id
    await db.insert(document).values({
      entityId: id,
      blobSha: sha(first),
      filename: 'memo.txt',
      mime: 'text/plain',
      sizeBytes: first.length,
    })

    // The real store for every write; only the blob read is replaced.
    const extractWith = async (bytes: Uint8Array) => {
      const real = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            return yield* ExtractionStore
          }),
          ExtractionStore.layer,
        ),
      )
      await Effect.runPromise(
        Effect.provide(
          Effect.provideService(
            extractDocument.run({ documentId: id }),
            JobContext,
            JobContext.of({
              queue: QUEUES.extractDocument,
              jobId: 'test',
              attempt: 1,
              isFinalAttempt: true,
            }),
          ),
          Layer.succeed(
            ExtractionStore,
            ExtractionStore.of({ ...real, bytes: () => Effect.succeed(bytes) }),
          ),
        ),
      )
    }

    await extractWith(first)
    expect(enqueued).toEqual([
      { name: QUEUES.embedDocument, data: { documentId: id } },
    ])
    await runJob(id)
    const once = await chunksOf(id)
    expect(once).toHaveLength(1)

    // Twice more over the same text: still one row per chunk index.
    await runJob(id)
    expect(await chunksOf(id)).toEqual(once)

    // New bytes, new text: the old cut is gone, not appended to.
    const long = Array.from(
      { length: 4 },
      (_, i) =>
        `Section ${String(i)}. ${'Launch cadence matters. '.repeat(90)}`,
    ).join('\n\n')
    const second = new TextEncoder().encode(long)
    await db
      .update(document)
      .set({ blobSha: sha(second) })
      .where(eq(document.entityId, id))
    await extractWith(second)
    await runJob(id)
    const after = await chunksOf(id)
    expect(after.length).toBeGreaterThan(1)
    expect(after.map((r) => r.idx)).toEqual(after.map((_, i) => i))
    expect(after.some((r) => r.text.includes('Seed round'))).toBe(false)
    const [{ value }] = await db
      .select({ value: count() })
      .from(chunk)
      .where(and(eq(chunk.entityId, id), eq(chunk.sourceKind, 'document')))
    expect(value).toBe(after.length)
  })
})

describe('the JobDef', () => {
  it('retries only on Postgres, and names the document for the ledger', () => {
    expect(embedDocument.name).toBe(QUEUES.embedDocument)
    expect(embedDocument.retry?.limit).toBe(2)
    const documentId = randomUUID()
    expect(embedDocument.refs?.({ documentId }).entityId).toBe(documentId)
  })
})

describe('document.embed and the sensitive slot (SPA-83)', () => {
  const SLOT = {
    provider: 'ollama',
    model: 'nomic-embed-text',
    dims: PIN_DIMS,
    set_at: '2026-09-25T00:00:00.000Z',
  }

  /** Ollama as the Providers section saves it: keyless, an address. */
  async function saveOllama() {
    await storeCredential({
      scope: 'workspace',
      provider: 'ollama',
      kind: 'llm',
      secret: '',
      keyless: true,
      meta: { baseUrl: 'http://ollama:11434' },
      createdBy: FIXTURE_ACTOR.id,
    })
  }

  it('embeds a sensitive document through the slot: vectors, the slot model stamped, the cloud pin never called', async () => {
    await saveOllama()
    await setSettings({ embedding: { ...PIN, sensitive: SLOT } })
    const id = await mkDocument('deck.pdf', deckText(3))
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    // No model seam: the real vault → Ollama adapter → the fake.
    await runJob(id)

    const rows = await chunksOf(id)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.embedding).toHaveLength(PIN_DIMS)
      expect(r.embeddingModel).toBe('nomic-embed-text')
      expect(r.sensitive).toBe(true)
    }
    // Every call went to Ollama; nothing to OpenAI.
    expect(ollama.calls.map((c) => c.url)).toEqual([
      'http://ollama:11434/api/embed',
    ])
    const usage = await db
      .select({ provider: aiUsage.provider })
      .from(aiUsage)
      .where(isNotNull(aiUsage.id))
    expect(usage).toEqual([{ provider: 'ollama' }])
  })

  it('with no slot, still leaves it unembedded and sends nothing — not to Ollama, not to the cloud pin', async () => {
    await saveOllama()
    await setSettings({ embedding: PIN })
    const id = await mkDocument('deck.pdf', deckText(2))
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    await runJob(id)

    const rows = await chunksOf(id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.embedding === null && r.sensitive)).toBe(true)
    expect(ollama.calls).toHaveLength(0)
    const usage = await db.select({ n: count() }).from(aiUsage)
    expect(usage.at(0)?.n).toBe(0)
  })
})
