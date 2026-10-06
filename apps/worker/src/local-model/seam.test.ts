import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Effect, Fiber } from 'effect'
import { count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { embedRequest, workspace } from '@spaces/db/schema'
import { LOCAL_EMBEDDING_MODELS } from '@spaces/core/ai/local-model'
import {
  LOCAL_EMBED_TIMEOUT_MS,
  closeLocalEmbedListener,
  requestLocalEmbeddingProgram,
} from '#web/lib/ai/local-embed'
import { pinEmbeddingProgram } from '#web/lib/ai/embedding-pin'
import {
  clearQueryEmbeddingCache,
  queryVectorOrNullProgram,
} from '#web/lib/search/query-embedding'
import { makeLocalModelHost } from './host'
import type { LocalModelHost } from './host'
import { serveEmbedRequests } from './serve'
import { copyModelByHand, fakeLoader, fakeVector } from './testing'

/**
 * The web-to-worker seam (D50) end to end on one test database: web's
 * `requestLocalEmbeddingProgram` on one connection, the worker's
 * `serveEmbedRequests` on another, the fake model behind it. What it proves:
 * a query vector comes back well inside the palette's budget, the vector
 * never rides a notification, and no worker means a bounded wait and no
 * leftover rows — the search falls back, it does not hang.
 */
vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const SPEC = LOCAL_EMBEDDING_MODELS[0]
const MODEL = SPEC.id

/** The issue's bar for a warm round trip: well under 100 ms. */
const WARM_ROUND_TRIP_MS = 100

let dataDir = ''
const savedDataDir = process.env.DATA_DIR
let running: Fiber.Fiber<never> | null = null
let host: LocalModelHost | null = null

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is unset in the test environment')
  return url
}

/** Starts the worker's responder; resolves once it is listening. */
async function startWorker(load = fakeLoader()) {
  const lines: Array<string> = []
  host = makeLocalModelHost({ load: load.load, idleMs: 60_000 })
  running = Effect.runFork(
    serveEmbedRequests({
      connectionString: connectionString(),
      host,
      log: (line) => lines.push(line),
    }),
  )
  for (let i = 0; i < 200; i += 1) {
    if (lines.some((l) => l.includes('listening on embed_request'))) break
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(lines.some((l) => l.includes('listening on embed_request'))).toBe(true)
  return { lines, counts: load.counts }
}

async function stopWorker() {
  if (running !== null) await Effect.runPromise(Fiber.interrupt(running))
  running = null
  if (host !== null) await Effect.runPromise(host.dispose())
  host = null
}

const requestRows = async () =>
  (await db.select({ n: count() }).from(embedRequest)).at(0)?.n ?? 0

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'spaces-seam-'))
  process.env.DATA_DIR = dataDir
  clearQueryEmbeddingCache()
})

afterEach(async () => {
  await stopWorker()
  closeLocalEmbedListener()
  if (savedDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = savedDataDir
  await rm(dataDir, { recursive: true, force: true })
})

describe('the local embedding seam', () => {
  it('returns a 768-wide vector to web well inside the wave budget', async () => {
    const worker = await startWorker()
    // The first request opens web's LISTEN connection and loads the model.
    await Effect.runPromise(requestLocalEmbeddingProgram(MODEL, ['warm up']))

    const times: Array<number> = []
    let last: Array<Array<number>> = []
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now()
      last = await Effect.runPromise(
        requestLocalEmbeddingProgram(MODEL, [`query ${String(i)}`]),
      )
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]
    const worst = times[times.length - 1]
    console.log(
      `[seam] warm round trip over 20 queries: median ${median.toFixed(1)}ms, worst ${worst.toFixed(1)}ms (budget ${String(LOCAL_EMBED_TIMEOUT_MS)}ms)`,
    )

    // The row stores float4, as `chunk.embedding` does: equal to 1e-6.
    const expected = fakeVector('query 19', 768)
    expect(last[0]).toHaveLength(768)
    expect(
      Math.max(...(last[0] ?? []).map((v, i) => Math.abs(v - expected[i]))),
    ).toBeLessThan(1e-6)
    expect(median).toBeLessThan(WARM_ROUND_TRIP_MS)
    expect(worst).toBeLessThan(LOCAL_EMBED_TIMEOUT_MS)
    expect(worker.counts.loads).toBe(1)
    // Every row web asked for is gone once it has its answer.
    expect(await requestRows()).toBe(0)
  })

  it('serves the search path: a query on a local pin gets its vector from the worker', async () => {
    await copyModelByHand(SPEC)
    await db
      .insert(workspace)
      .values({ id: 1, name: 'Fund', settings: {} })
      .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
    await Effect.runPromise(
      pinEmbeddingProgram({ provider: 'local', model: MODEL }),
    )
    const worker = await startWorker()

    const t0 = performance.now()
    const answer = await Effect.runPromise(
      queryVectorOrNullProgram('heat rejection in racks', {
        caller: { type: 'system' },
      }),
    )
    const ms = performance.now() - t0
    console.log(`[seam] cold search-path query: ${ms.toFixed(1)}ms`)

    expect(answer?.model).toBe(MODEL)
    expect(answer?.vector).toHaveLength(768)
    expect(worker.counts.batches).toEqual([['heat rejection in racks']])
  })

  it('with no worker listening, gives up within its timeout and leaves no row', async () => {
    const t0 = performance.now()
    const r = await Effect.runPromise(
      Effect.result(requestLocalEmbeddingProgram(MODEL, ['anyone?'], 150)),
    )
    const ms = performance.now() - t0

    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') expect(r.failure.reason).toMatch(/within 150ms/)
    expect(ms).toBeLessThan(1_000)
    expect(await requestRows()).toBe(0)
  })

  it('falls back to lexical on a local pin when no worker answers', async () => {
    await copyModelByHand(SPEC)
    await db
      .insert(workspace)
      .values({ id: 1, name: 'Fund', settings: {} })
      .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
    await Effect.runPromise(
      pinEmbeddingProgram({ provider: 'local', model: MODEL }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const t0 = performance.now()
    const answer = await Effect.runPromise(
      queryVectorOrNullProgram('nobody home', { caller: { type: 'system' } }),
    )
    const ms = performance.now() - t0

    expect(answer).toBeNull()
    expect(ms).toBeLessThan(LOCAL_EMBED_TIMEOUT_MS + 1_000)
    expect(await requestRows()).toBe(0)
    warn.mockRestore()
  })

  it('carries the worker’s refusal back as a failure, without waiting out the timeout', async () => {
    await startWorker()
    const t0 = performance.now()
    const r = await Effect.runPromise(
      Effect.result(requestLocalEmbeddingProgram('no-such-model', ['x'])),
    )
    const ms = performance.now() - t0

    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure')
      expect(r.failure.reason).toMatch(/not a local model/)
    expect(ms).toBeLessThan(LOCAL_EMBED_TIMEOUT_MS)
  })

  it('prunes request rows whose asker went away when it starts listening', async () => {
    const stale = randomUUID()
    await db.insert(embedRequest).values({
      id: stale,
      model: MODEL,
      text: 'abandoned',
      createdAt: new Date(Date.now() - 5 * 60_000),
    })
    const fresh = randomUUID()
    await db
      .insert(embedRequest)
      .values({ id: fresh, model: MODEL, text: 'just asked' })

    await startWorker()
    await new Promise((r) => setTimeout(r, 100))

    const left = await db
      .select({ id: embedRequest.id })
      .from(embedRequest)
      .where(eq(embedRequest.id, stale))
    expect(left).toEqual([])
    const kept = await db
      .select({ id: embedRequest.id })
      .from(embedRequest)
      .where(eq(embedRequest.id, fresh))
    expect(kept).toHaveLength(1)
  })
})
