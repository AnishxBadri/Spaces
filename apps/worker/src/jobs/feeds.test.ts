import { createHash } from 'node:crypto'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { feed, feedItem, pendingBlob } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { storage } from '@spaces/core/writes/storage'
import { pictureOf, rssOf, stubSite } from '#web/lib/feeds/fixtures'
import { JobContext } from '../run-job'
import type { JobDef, JobResult } from '../run-job'
import {
  feedFetch,
  feedImages,
  feedLogo,
  feedLogos,
  feedPoll,
  feedPrune,
} from './feeds'
import { sweepOrphanBlobsProgram } from './sweep-orphan-blobs'

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

/** An `Enqueue` that records what was sent, with the payload. */
const recorder = () => {
  const sent: Array<{
    queue: string
    data: Record<string, unknown>
    key: string | undefined
  }> = []
  const layer = Layer.succeed(
    Enqueue,
    Enqueue.of({
      enqueue: (queue, data, options) =>
        Effect.sync(() => {
          sent.push({ queue, data, key: options?.singletonKey })
          return 'job'
        }),
    }),
  )
  return { sent, layer }
}

const shaOf = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

describe('feed.fetch', () => {
  it('keeps the new items, says how many, and sends their photos to their own queue', async () => {
    const id = await aFeed('https://w.example/ok')
    const requests = stubSite({
      'https://w.example/ok': () => ({ status: 200, body: STORY }),
    })
    const { sent, layer } = recorder()
    expect(await run(feedFetch, { feedId: id }, layer)).toEqual({
      ok: '1 new of 1',
    })
    const item = (
      await db.select().from(feedItem).where(eq(feedItem.feedId, id))
    ).at(0)
    expect(sent).toEqual([
      {
        queue: QUEUES.feedImages,
        data: { itemIds: [item?.id] },
        key: undefined,
      },
    ])
    // The photo was not asked for by the fetch.
    expect(requests.map((r) => r.url)).toEqual(['https://w.example/ok'])
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
    expect(await run(feedFetch, { feedId: id }, recorder().layer)).toEqual({
      failed: outcome,
    })
    const row = (await db.select().from(feed).where(eq(feed.id, id))).at(0)
    expect(row).toMatchObject({
      lastStatus: 'failed',
      lastError: `The site answered ${String(status)}`,
    })
  })
})

describe('feed.poll and feed.logos', () => {
  it('sends one fetch, and weekly one logo, per feed, keyed by the feed', async () => {
    const ids = [
      await aFeed('https://w.example/p1'),
      await aFeed('https://w.example/p2'),
    ]
    const polls = recorder()
    const out = await run(feedPoll, {}, polls.layer)
    expect(out).toMatchObject({ ok: expect.stringContaining('fetches sent') })
    const logos = recorder()
    expect(await run(feedLogos, {}, logos.layer)).toMatchObject({
      ok: expect.stringContaining('logo fetches sent'),
    })
    for (const id of ids) {
      expect(polls.sent).toContainEqual({
        queue: QUEUES.feedFetch,
        data: { feedId: id },
        key: id,
      })
      expect(logos.sent).toContainEqual({
        queue: QUEUES.feedLogo,
        data: { feedId: id },
        key: id,
      })
    }
  })
})

describe('feed.images and feed.logo', () => {
  it('store a photo and a favicon, and a refused photo is a success that skips', async () => {
    const id = await aFeed('https://pic.example/feed')
    const photo = pictureOf('jpeg')
    const icon = pictureOf('ico')
    stubSite({
      'https://pic.example/a.jpg': () => ({ status: 200, body: photo }),
      'https://pic.example/b.jpg': () => ({ status: 403 }),
      'https://pic.example/favicon.ico': () => ({ status: 200, body: icon }),
    })
    const items = await db
      .insert(feedItem)
      .values(
        ['a', 'b'].map((k) => ({
          feedId: id,
          key: k,
          title: k,
          publishedAt: new Date(),
          imageUrl: `https://pic.example/${k}.jpg`,
        })),
      )
      .returning({ id: feedItem.id })

    expect(
      await run(feedImages, { itemIds: items.map((i) => i.id) }, Layer.empty),
    ).toEqual({ ok: '1 photos stored, 1 skipped' })
    expect(await run(feedLogo, { feedId: id }, Layer.empty)).toEqual({
      ok: 'logo stored',
    })
    const row = (await db.select().from(feed).where(eq(feed.id, id))).at(0)
    expect(row?.logoSha).toBe(shaOf(icon))
  })
})

describe('the orphan sweep and feed pictures', () => {
  it('keeps a logo and a photo while their rows hold them, and reclaims them once the rows go', async () => {
    const id = await aFeed('https://sweep.example/feed')
    const logo = pictureOf('png')
    const photo = pictureOf('jpeg')
    for (const bytes of [logo, photo])
      await storage().put(shaOf(bytes), Buffer.from(bytes), {
        mime: 'image/png',
      })
    await db
      .update(feed)
      .set({ logoSha: shaOf(logo) })
      .where(eq(feed.id, id))
    await db.insert(feedItem).values({
      feedId: id,
      key: 'p',
      title: 'P',
      publishedAt: new Date(),
      imageSha: shaOf(photo),
    })
    // An intent past its grace, as a worker that died before clearing it
    // would leave.
    const intents = () =>
      db
        .insert(pendingBlob)
        .values([{ sha: shaOf(logo) }, { sha: shaOf(photo) }])
        .onConflictDoNothing()
    await intents()

    const held = await Effect.runPromise(
      sweepOrphanBlobsProgram({ graceMs: 0 }),
    )
    expect(held).toMatchObject({ reclaimed: 0, kept: 2 })
    expect(await storage().exists(shaOf(logo))).toBe(true)
    expect(await storage().exists(shaOf(photo))).toBe(true)

    await db.delete(feed).where(eq(feed.id, id))
    await intents()
    const freed = await Effect.runPromise(
      sweepOrphanBlobsProgram({ graceMs: 0 }),
    )
    expect(freed).toMatchObject({ reclaimed: 2 })
    expect(await storage().exists(shaOf(logo))).toBe(false)
    expect(await storage().exists(shaOf(photo))).toBe(false)
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
      ok: 'deleted 1, 0 photos reclaimed',
    })
  })
})
