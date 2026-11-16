import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { feed, feedItem } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { rssOf, stubSite } from '#web/lib/feeds/fixtures'
import { JobContext } from '../run-job'
import type { JobDef, JobResult } from '../run-job'
import { feedFetch, feedPoll, feedPrune } from './feeds'

/**
 * The feed jobs as `runJob` runs them, minus the ledger: the outcome each
 * failure maps to, the fan-out, and the daily delete. `fetch` is stubbed;
 * the database is this worker's own, truncated before the file.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const context = (queue: string) =>
  Layer.succeed(
    JobContext,
    JobContext.of({ queue, jobId: 'test', attempt: 1, isFinalAttempt: true }),
  )

const run = async <TData, TServices>(
  def: JobDef<TData, TServices>,
  data: TData,
  layer: Layer.Layer<TServices>,
): Promise<{ ok: JobResult } | { failed: string }> => {
  const exit = await Effect.runPromiseExit(
    def.run(data).pipe(Effect.provide(Layer.merge(layer, context(def.name)))),
  )
  if (Exit.isSuccess(exit)) return { ok: exit.value }
  const failure = Cause.findErrorOption(exit.cause)
  // A typed failure, never a defect: a throw past the wrapper kills the worker.
  if (Option.isNone(failure)) throw new Error('expected a typed failure')
  return { failed: failure.value._tag }
}

const aFeed = async (url: string) => {
  const row = (
    await db.insert(feed).values({ url, name: url }).returning({ id: feed.id })
  ).at(0)
  if (row === undefined) throw new Error('no feed')
  return row.id
}

const STORY = rssOf([
  { guid: 's', title: 'A story', date: new Date().toISOString() },
])

describe('feed.fetch', () => {
  it('keeps the new items and says how many', async () => {
    const id = await aFeed('https://w.example/ok')
    stubSite({ 'https://w.example/ok': () => ({ status: 200, body: STORY }) })
    expect(await run(feedFetch, { feedId: id }, Layer.empty)).toEqual({
      ok: '1 new of 1',
    })
  })

  it.each([
    [404, 'JobPermanent'],
    [410, 'JobPermanent'],
    [429, 'JobRetryable'],
    [503, 'JobRetryable'],
  ])('a %i is %s, written on the row first', async (status, outcome) => {
    const url = `https://w.example/${String(status)}`
    const id = await aFeed(url)
    stubSite({ [url]: () => ({ status }) })
    expect(await run(feedFetch, { feedId: id }, Layer.empty)).toEqual({
      failed: outcome,
    })
    const row = (await db.select().from(feed).where(eq(feed.id, id))).at(0)
    expect(row).toMatchObject({
      lastStatus: 'failed',
      lastError: `The site answered ${String(status)}`,
    })
  })
})

describe('feed.poll', () => {
  it('sends one fetch per feed, keyed by the feed', async () => {
    const ids = [
      await aFeed('https://w.example/p1'),
      await aFeed('https://w.example/p2'),
    ]
    const sent: Array<{ queue: string; key: string | undefined }> = []
    const recording = Layer.succeed(
      Enqueue,
      Enqueue.of({
        enqueue: (queue, _data, options) =>
          Effect.sync(() => {
            sent.push({ queue, key: options?.singletonKey })
            return 'job'
          }),
      }),
    )
    const out = await run(feedPoll, {}, recording)
    expect(out).toMatchObject({ ok: expect.stringContaining('fetches sent') })
    for (const id of ids)
      expect(sent).toContainEqual({ queue: QUEUES.feedFetch, key: id })
  })
})

describe('feed.prune', () => {
  it('deletes headlines past ninety days', async () => {
    const id = await aFeed('https://w.example/prune')
    await db.insert(feedItem).values({
      feedId: id,
      key: 'old',
      title: 'Old',
      publishedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    })
    expect(await run(feedPrune, {}, Layer.empty)).toEqual({
      ok: 'deleted 1',
    })
  })
})
