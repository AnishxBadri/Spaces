import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { chunk, document, entity, workspace } from '@spaces/db/schema'
import { LOCAL_EMBEDDING_MODELS } from '@spaces/core/ai/local-model'
import { embedBackfillProgram } from '#web/lib/ai/embed-backfill'
import { EMBED_BATCH } from '#web/lib/ai/embed-chunks'
import { pinEmbeddingProgram } from '#web/lib/ai/embedding-pin'
import { installLocalEmbedder } from '#web/lib/ai/providers/embed/local'
import { makeLocalModelHost } from './host'
import { copyModelByHand, fakeLoader } from './testing'

/**
 * The worker's one local model instance (D50), against the fake loader:
 * loads are counted, so "loaded once across jobs" and "freed when idle" are
 * assertions, not hopes. No weights are downloaded anywhere in this file.
 */
vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const SPEC = LOCAL_EMBEDDING_MODELS[0]
const MODEL = SPEC.id

let dataDir = ''
const savedDataDir = process.env.DATA_DIR

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'spaces-models-'))
  process.env.DATA_DIR = dataDir
})

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = savedDataDir
  await rm(dataDir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the local model host', () => {
  it('loads once for many calls, and concurrent first calls share the load', async () => {
    const fake = fakeLoader()
    const host = makeLocalModelHost({ load: fake.load, idleMs: 60_000 })
    const answers = await Promise.all(
      ['a', 'b', 'c'].map((t) => Effect.runPromise(host.embed(MODEL, [t]))),
    )
    for (let i = 0; i < 5; i += 1)
      await Effect.runPromise(host.embed(MODEL, [`more ${String(i)}`]))

    expect(fake.counts.loads).toBe(1)
    expect(host.loads()).toBe(1)
    expect(answers.map((a) => a[0]?.length)).toEqual([768, 768, 768])
    expect(host.isLoaded(MODEL)).toBe(true)
    await Effect.runPromise(host.dispose())
  })

  it('disposes the model after the idle interval, and the next call loads again', async () => {
    const fake = fakeLoader()
    const host = makeLocalModelHost({ load: fake.load, idleMs: 40 })
    await Effect.runPromise(host.embed(MODEL, ['first']))
    expect(fake.counts.disposes).toBe(0)

    await sleep(120)
    expect(fake.counts.disposes).toBe(1)
    expect(host.isLoaded(MODEL)).toBe(false)

    await Effect.runPromise(host.embed(MODEL, ['after idle']))
    expect(fake.counts.loads).toBe(2)
    await Effect.runPromise(host.dispose())
  })

  it('does not dispose while a call is in flight', async () => {
    const fake = fakeLoader({ latencyMs: 120 })
    const host = makeLocalModelHost({ load: fake.load, idleMs: 30 })
    await Effect.runPromise(host.embed(MODEL, ['warm']))
    await Effect.runPromise(host.embed(MODEL, ['slow call']))
    expect(fake.counts.disposes).toBe(0)
    expect(fake.counts.loads).toBe(1)
    await Effect.runPromise(host.dispose())
    expect(fake.counts.disposes).toBe(1)
  })

  it('refuses a model the catalogue does not list', async () => {
    const host = makeLocalModelHost({ load: fakeLoader().load })
    const r = await Effect.runPromise(
      Effect.result(host.embed('not-a-model', ['x'])),
    )
    expect(r._tag).toBe('Failure')
  })

  it('a backfill of N batches on a local pin loads the model once', async () => {
    await copyModelByHand(SPEC)
    await db
      .insert(workspace)
      .values({ id: 1, name: 'Fund', settings: {} })
      .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
    await Effect.runPromise(
      pinEmbeddingProgram({ provider: 'local', model: MODEL }),
    )

    const deck = (
      await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: 'Corpus' })
        .returning({ id: entity.id })
    ).at(0)
    if (!deck) throw new Error('entity insert returned nothing')
    await db.insert(document).values({
      entityId: deck.id,
      filename: 'corpus.pdf',
      kind: 'deck',
      sourceClass: 'manual',
      extractionStatus: 'done',
      extractedText: 'corpus',
      tsv: sql`to_tsvector('english', 'corpus')`,
    })
    const batches = 3
    await db.insert(chunk).values(
      Array.from({ length: EMBED_BATCH * batches }, (_, i) => ({
        entityId: deck.id,
        sourceKind: 'document' as const,
        sourceKey: '',
        idx: i,
        text: `Chunk ${String(i)} of the corpus.`,
      })),
    )

    const fake = fakeLoader({ requireFiles: true })
    const host = makeLocalModelHost({ load: fake.load, idleMs: 60_000 })
    const uninstall = installLocalEmbedder((model, texts) =>
      host.embed(model, texts),
    )
    try {
      const result = await Effect.runPromise(embedBackfillProgram())
      expect(result).toMatchObject({
        embedded: EMBED_BATCH * batches,
        model: MODEL,
      })
    } finally {
      uninstall()
      await Effect.runPromise(host.dispose())
    }
    expect(fake.counts.batches).toHaveLength(batches)
    expect(fake.counts.loads).toBe(1)
  })
})
