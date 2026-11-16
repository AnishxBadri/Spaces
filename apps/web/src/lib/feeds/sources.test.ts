import { Effect, Exit } from 'effect'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { entity, feed, feedItem, feedSpace, space } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { pollFeedProgram } from './poll'
import {
  addFeedProgram,
  editFeedProgram,
  listFeedSourcesProgram,
  listHeadlinesProgram,
  removeFeedProgram,
} from './sources'
import { rssOf, stubSite } from './fixtures'

/**
 * The Feeds page's programs against a stubbed web and this worker's test
 * database (truncated before the file). The queue is stubbed: the test
 * databases have no `pgboss` schema.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const me = async () =>
  (await db.execute<{ id: string }>('select id from "user" limit 1')).rows[0].id

let n = 0
const aSpace = async (name: string, parentPath?: string) => {
  n += 1
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (ent === undefined) throw new Error('no space')
  const slug = `f${String(n)}`
  const path = parentPath === undefined ? slug : `${parentPath}.${slug}`
  await db.insert(space).values({ entityId: ent.id, slug, path })
  return { id: ent.id, path }
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

const SITE_PAGE = `<!doctype html><html><head>
  <title>SpaceNews</title>
  <link rel="alternate" type="application/rss+xml" title="SpaceNews" href="https://spacenews.com/feed/">
</head><body>Home</body></html>`

const STORIES = rssOf([
  { guid: 'launch', title: 'A launch', date: '2026-11-15T09:00:00Z' },
  { guid: 'deal', title: 'A deal', date: '2026-11-14T09:00:00Z' },
])

describe('Add feed', () => {
  it('resolves a site address to its feed, tags it, sends its first fetch, and the fetch holds its items', async () => {
    const orbit = await aSpace('Orbit')
    stubSite({
      'https://spacenews.com/': () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: SITE_PAGE,
      }),
      'https://spacenews.com/feed/': () => ({ status: 200, body: STORIES }),
    })

    const added = await Effect.runPromise(
      addFeedProgram(await me(), {
        address: 'spacenews.com',
        spaceIds: [orbit.id],
      }),
    )

    expect(added.source).toMatchObject({
      name: 'SpaceNews',
      url: 'https://spacenews.com/feed/',
      siteUrl: 'https://spacenews.com/',
      state: 'new',
      spaces: [{ id: orbit.id, name: 'Orbit' }],
      headlineCount: 0,
    })
    expect(added.newest).toEqual({
      title: 'A launch',
      url: 'https://spacenews.com/launch/',
      publishedAt: '2026-11-15T09:00:00.000Z',
    })
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      {
        name: QUEUES.feedFetch,
        data: { feedId: added.source.id },
        options: { singletonKey: added.source.id },
      },
    ])

    // The fetch the add sent, as the worker runs it.
    await Effect.runPromise(pollFeedProgram(added.source.id))
    const sources = await Effect.runPromise(listFeedSourcesProgram())
    expect(sources.find((s) => s.id === added.source.id)).toMatchObject({
      state: 'ok',
      headlineCount: 2,
      newestAt: '2026-11-15T09:00:00.000Z',
    })
  })

  it('refuses a page with no feed, an address taken by another feed, and a space that is gone', async () => {
    stubSite({
      'https://plain.example/': () => ({ status: 200, body: '<html></html>' }),
      'https://taken.example/rss': () => ({
        status: 200,
        body: rssOf([], 'Taken'),
      }),
    })
    const user = await me()
    expect(
      failureOf(
        await Effect.runPromiseExit(
          addFeedProgram(user, { address: 'plain.example', spaceIds: [] }),
        ),
      ),
    ).toMatchObject({ message: 'That page has no feed' })

    await Effect.runPromise(
      addFeedProgram(user, {
        address: 'https://taken.example/rss',
        spaceIds: [],
      }),
    )
    expect(
      failureOf(
        await Effect.runPromiseExit(
          addFeedProgram(user, {
            address: 'https://taken.example/rss',
            spaceIds: [],
          }),
        ),
      ),
    ).toMatchObject({ message: 'Already a source: Taken' })

    expect(
      failureOf(
        await Effect.runPromiseExit(
          addFeedProgram(user, {
            address: 'https://taken.example/rss',
            spaceIds: ['00000000-0000-4000-8000-000000000000'],
          }),
        ),
      ),
    ).toMatchObject({ message: 'A chosen space is gone' })
  })

  it('refuses with the site’s answer when the address fails', async () => {
    stubSite({})
    expect(
      failureOf(
        await Effect.runPromiseExit(
          addFeedProgram(await me(), {
            address: 'https://missing.example/feed',
            spaceIds: [],
          }),
        ),
      ),
    ).toMatchObject({ message: 'The site answered 404' })
  })
})

describe('Edit and remove', () => {
  it('renames, retags, moves the address with a fresh fetch, and removes with the headlines', async () => {
    stubSite({
      'https://one.example/rss': () => ({
        status: 200,
        body: rssOf([], 'One'),
      }),
      'https://two.example/rss': () => ({
        status: 200,
        body: rssOf([], 'Two'),
      }),
    })
    const a = await aSpace('Launch')
    const b = await aSpace('Defence')
    const added = await Effect.runPromise(
      addFeedProgram(await me(), {
        address: 'https://one.example/rss',
        spaceIds: [a.id],
      }),
    )
    const id = added.source.id
    await db
      .update(feed)
      .set({ etag: '"old"', lastStatus: 'failed', lastError: 'Timed out' })
      .where(eq(feed.id, id))
    const { enqueued } = await import('#/test/queue-stub')
    enqueued.length = 0

    const edited = await Effect.runPromise(
      editFeedProgram({
        id,
        name: 'Renamed',
        address: 'https://two.example/rss',
        spaceIds: [b.id],
      }),
    )

    expect(edited).toMatchObject({
      name: 'Renamed',
      url: 'https://two.example/rss',
      state: 'new',
      lastError: null,
      spaces: [{ id: b.id, name: 'Defence' }],
    })
    expect(
      (await db.select().from(feed).where(eq(feed.id, id))).at(0)?.etag,
    ).toBeNull()
    expect(enqueued.map((e) => e.name)).toEqual([QUEUES.feedFetch])

    await db
      .insert(feedItem)
      .values({ feedId: id, key: 'k', title: 'T', publishedAt: new Date() })
    expect(await Effect.runPromise(removeFeedProgram(id))).toEqual({
      removed: true,
    })
    expect(
      await db.select().from(feedItem).where(eq(feedItem.feedId, id)),
    ).toEqual([])
    expect(
      await db.select().from(feedSpace).where(eq(feedSpace.feedId, id)),
    ).toEqual([])
    expect(await Effect.runPromise(removeFeedProgram(id))).toEqual({
      removed: false,
    })
  })
})

describe('Headlines', () => {
  it('pages newest first and narrows to a space and the spaces under it', async () => {
    const parent = await aSpace('Space economy')
    const child = await aSpace('Launch', parent.path)
    const other = await aSpace('Fintech')
    const feedRow = async (url: string, name: string, spaceId: string) => {
      const row = (
        await db.insert(feed).values({ url, name }).returning({ id: feed.id })
      ).at(0)
      if (row === undefined) throw new Error('no feed')
      await db.insert(feedSpace).values({ feedId: row.id, spaceId })
      return row.id
    }
    const launch = await feedRow(
      'https://h.example/launch',
      'Launch wire',
      child.id,
    )
    const money = await feedRow(
      'https://h.example/money',
      'Money wire',
      other.id,
    )
    const base = Date.parse('2026-11-10T00:00:00Z')
    const hour = 60 * 60 * 1000
    await db.insert(feedItem).values([
      ...[0, 1, 2, 3, 4].map((i) => ({
        feedId: launch,
        key: `l${String(i)}`,
        title: `Launch ${String(i)}`,
        publishedAt: new Date(base + i * hour),
        imageUrl: `https://h.example/${String(i)}.jpg`,
      })),
      // Two at one instant: the id breaks the tie, and paging keeps both.
      ...[0, 1].map((i) => ({
        feedId: money,
        key: `m${String(i)}`,
        title: `Money ${String(i)}`,
        publishedAt: new Date(base + 10 * hour),
      })),
    ])

    const all: Array<string> = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const got = await Effect.runPromise(
        listHeadlinesProgram({
          limit: 3,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      )
      all.push(...got.headlines.map((h) => h.title))
      if (got.nextCursor === null) break
      cursor = got.nextCursor
    }
    // Earlier tests in this file left their own headlines, dated later.
    const mine = all.filter((t) => /^(Launch|Money) /.test(t))
    expect(new Set(all).size).toBe(all.length)
    expect(mine.slice(0, 2).sort()).toEqual(['Money 0', 'Money 1'])
    expect(mine.slice(2)).toEqual([
      'Launch 4',
      'Launch 3',
      'Launch 2',
      'Launch 1',
      'Launch 0',
    ])

    const inParent = await Effect.runPromise(
      listHeadlinesProgram({ spaceId: parent.id }),
    )
    expect(inParent.headlines.map((h) => h.feedName)).toEqual(
      Array.from({ length: 5 }, () => 'Launch wire'),
    )
    expect(inParent.headlines.at(0)).toMatchObject({
      title: 'Launch 4',
      imageUrl: 'https://h.example/4.jpg',
      imageSha: null,
      publishedAt: '2026-11-10T04:00:00.000Z',
    })
    expect(inParent.nextCursor).toBeNull()

    // A forged cursor is page one, never a database error.
    const forged = await Effect.runPromise(
      listHeadlinesProgram({ cursor: 'not-a-cursor', limit: 1 }),
    )
    expect(forged.headlines).toHaveLength(1)
  })
})
