import { Effect, Exit } from 'effect'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { feed, feedItem } from '@spaces/db/schema'
import { pollFeedProgram, pruneFeedItemsProgram } from './poll'
import { rssOf, stubSite } from './fixtures'

/**
 * One feed polled against a stubbed web and this worker's test database
 * (truncated before the file): what lands, what a second fetch sends, what
 * a failure keeps, and the daily delete.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const FEED_URL = 'https://spacenews.com/feed/'
const now = new Date('2026-11-16T12:00:00.000Z')

const aFeed = async (url = FEED_URL) => {
  const row = (
    await db
      .insert(feed)
      .values({ url, name: 'SpaceNews', siteUrl: 'https://spacenews.com/' })
      .returning({ id: feed.id })
  ).at(0)
  if (row === undefined) throw new Error('no feed')
  return row.id
}

const rowOf = async (id: string) =>
  (await db.select().from(feed).where(eq(feed.id, id))).at(0)

const itemsOf = (id: string) =>
  db.select().from(feedItem).where(eq(feedItem.feedId, id))

const TWO = rssOf([
  { guid: 'launch', title: 'A launch', date: '2026-11-15T09:00:00Z' },
  { guid: 'deal', title: 'A deal', date: '2026-11-14T09:00:00Z' },
])

describe('pollFeedProgram', () => {
  it('keeps every new item, with its summary and photo, and the validators', async () => {
    const id = await aFeed(`${FEED_URL}?a`)
    stubSite({
      [`${FEED_URL}?a`]: () => ({
        status: 200,
        headers: {
          etag: '"v1"',
          'last-modified': 'Sun, 15 Nov 2026 09:00:00 GMT',
        },
        body: TWO,
      }),
    })

    const polled = await Effect.runPromise(pollFeedProgram(id, now))

    const items = await itemsOf(id)
    // Both name a photo, handed back for `feed.images` rather than fetched.
    expect(polled).toEqual({
      _tag: 'Fetched',
      seen: 2,
      added: 2,
      withImages: expect.arrayContaining(items.map((i) => i.id)),
    })
    expect(items.map((i) => i.title).sort()).toEqual(['A deal', 'A launch'])
    expect(items.find((i) => i.key === 'launch')).toMatchObject({
      url: 'https://spacenews.com/launch/',
      summary: 'A launch, the story.\n\nSecond paragraph.',
      imageUrl: 'https://spacenews.com/img/launch.jpg',
      publishedAt: new Date('2026-11-15T09:00:00Z'),
    })
    expect(await rowOf(id)).toMatchObject({
      lastStatus: 'ok',
      lastError: null,
      lastFetchedAt: now,
      lastSuccessAt: now,
      etag: '"v1"',
      lastModified: 'Sun, 15 Nov 2026 09:00:00 GMT',
    })
  })

  it('sends the validators the second time and inserts nothing for a 304, or for the same items again', async () => {
    const id = await aFeed(`${FEED_URL}?b`)
    let unchanged = 0
    const requests = stubSite({
      [`${FEED_URL}?b`]: (headers) =>
        headers.get('if-none-match') === '"v1"' && unchanged++ === 0
          ? { status: 304 }
          : { status: 200, headers: { etag: '"v1"' }, body: TWO },
    })

    await Effect.runPromise(pollFeedProgram(id, now))
    const second = await Effect.runPromise(pollFeedProgram(id, now))
    // A site that ignores the validator and sends the same feed again.
    const third = await Effect.runPromise(pollFeedProgram(id, now))

    expect(requests.map((r) => r.headers.get('if-none-match'))).toEqual([
      null,
      '"v1"',
      '"v1"',
    ])
    expect(second).toEqual({ _tag: 'NotModified' })
    expect(third).toEqual({
      _tag: 'Fetched',
      seen: 2,
      added: 0,
      withImages: [],
    })
    expect(await itemsOf(id)).toHaveLength(2)
    expect((await rowOf(id))?.lastStatus).toBe('ok')
  })

  it('records a 404 with its reason, keeps the old items, and recovers on the next good fetch', async () => {
    const id = await aFeed(`${FEED_URL}?c`)
    let gone = false
    stubSite({
      [`${FEED_URL}?c`]: () =>
        gone ? { status: 404 } : { status: 200, body: TWO },
    })
    await Effect.runPromise(pollFeedProgram(id, now))

    gone = true
    const later = new Date(now.getTime() + 30 * 60 * 1000)
    const exit = await Effect.runPromiseExit(pollFeedProgram(id, later))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error('unreachable')
    const failure = exit.cause.reasons.find((r) => r._tag === 'Fail')
    expect(failure?._tag === 'Fail' ? failure.error : null).toMatchObject({
      _tag: 'FeedFetchFailed',
      message: 'The site answered 404',
      status: 404,
      retryable: false,
    })
    expect(await rowOf(id)).toMatchObject({
      lastStatus: 'failed',
      lastError: 'The site answered 404',
      lastFetchedAt: later,
      lastSuccessAt: now,
    })
    expect(await itemsOf(id)).toHaveLength(2)

    gone = false
    const recovered = new Date(later.getTime() + 30 * 60 * 1000)
    await Effect.runPromise(pollFeedProgram(id, recovered))
    expect(await rowOf(id)).toMatchObject({
      lastStatus: 'ok',
      lastError: null,
      lastSuccessAt: recovered,
    })
  })

  it('says a document that stopped being a feed is "Not a feed any more"', async () => {
    const id = await aFeed(`${FEED_URL}?d`)
    stubSite({
      [`${FEED_URL}?d`]: () => ({ status: 200, body: '<html>Moved</html>' }),
    })
    await Effect.runPromiseExit(pollFeedProgram(id, now))
    expect((await rowOf(id))?.lastError).toBe('Not a feed any more')
  })

  it('answers Gone for a feed removed while its fetch was queued', async () => {
    expect(
      await Effect.runPromise(
        pollFeedProgram('00000000-0000-4000-8000-000000000000', now),
      ),
    ).toEqual({ _tag: 'Gone' })
  })
})

describe('pruneFeedItemsProgram', () => {
  it('deletes every headline published more than ninety days ago', async () => {
    const id = await aFeed(`${FEED_URL}?e`)
    const day = 24 * 60 * 60 * 1000
    await db.insert(feedItem).values([
      {
        feedId: id,
        key: 'old',
        title: 'Old',
        publishedAt: new Date(now.getTime() - 91 * day),
      },
      {
        feedId: id,
        key: 'kept',
        title: 'Kept',
        publishedAt: new Date(now.getTime() - 89 * day),
      },
    ])

    const { deleted } = await Effect.runPromise(pruneFeedItemsProgram(now))

    expect(deleted).toBe(1)
    expect((await itemsOf(id)).map((i) => i.key)).toEqual(['kept'])
  })
})
