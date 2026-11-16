import { Effect } from 'effect'
import { count } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { feed } from '@spaces/db/schema'
import { previewFeedProgram } from './preview'
import { addFeedProgram } from './sources'
import { rssOf, stubSite } from './fixtures'

/**
 * Add feed's look ahead against a stubbed web and this worker's test
 * database: what an address resolves to, and the sentence when it will not
 * add. It saves nothing.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

afterEach(() => {
  vi.unstubAllGlobals()
})

const SITE_PAGE = `<!doctype html><html><head>
  <link rel="alternate" type="application/rss+xml" title="SpaceNews" href="https://spacenews.com/feed/">
</head><body>Home</body></html>`

const NOW = new Date('2026-11-16T11:00:00Z')

const feeds = async () =>
  (await db.select({ n: count() }).from(feed)).at(0)?.n ?? 0

describe('previewFeedProgram', () => {
  it('resolves a site address to its feed, its name and how recent its newest story is, and saves nothing', async () => {
    stubSite({
      'https://spacenews.com/': () => ({ status: 200, body: SITE_PAGE }),
      'https://spacenews.com/feed/': () => ({
        status: 200,
        body: rssOf([
          { guid: 'old', title: 'Old', date: '2026-11-14T09:00:00Z' },
          { guid: 'new', title: 'New', date: '2026-11-16T09:00:00Z' },
        ]),
      }),
    })
    const before = await feeds()

    const preview = await Effect.runPromise(
      previewFeedProgram('spacenews.com', NOW),
    )

    expect(preview).toEqual({
      _tag: 'Found',
      name: 'SpaceNews',
      url: 'https://spacenews.com/feed/',
      newestAt: '2026-11-16T09:00:00.000Z',
      newestSinceMs: 2 * 60 * 60 * 1000,
    })
    expect(await feeds()).toBe(before)
  })

  it("says a page has no feed with the way out, and the site's own answer as a sentence", async () => {
    stubSite({
      'https://plain.example/story': () => ({
        status: 200,
        body: '<html></html>',
      }),
      'https://gone.example/feed': () => ({ status: 404 }),
    })

    expect(
      await Effect.runPromise(previewFeedProgram('plain.example/story', NOW)),
    ).toEqual({
      _tag: 'Refused',
      message:
        "That page has no feed. Paste the site's address or its RSS link.",
    })
    expect(
      await Effect.runPromise(
        previewFeedProgram('https://gone.example/feed', NOW),
      ),
    ).toEqual({ _tag: 'Refused', message: 'The site answered 404.' })
  })

  it('refuses a feed that is already a source, by its name', async () => {
    stubSite({
      'https://taken.example/rss': () => ({
        status: 200,
        body: rssOf([], 'Taken'),
      }),
    })
    const user = (
      await db.execute<{ id: string }>('select id from "user" limit 1')
    ).rows[0].id
    await Effect.runPromise(
      addFeedProgram(user, {
        address: 'https://taken.example/rss',
        spaceIds: [],
      }),
    )

    expect(
      await Effect.runPromise(
        previewFeedProgram('https://taken.example/rss', NOW),
      ),
    ).toEqual({ _tag: 'Refused', message: 'Already a source: Taken.' })
  })

  it('has no newest story to show for a feed with none', async () => {
    stubSite({
      'https://quiet.example/rss': () => ({
        status: 200,
        body: rssOf([], 'Quiet'),
      }),
    })
    expect(
      await Effect.runPromise(
        previewFeedProgram('https://quiet.example/rss', NOW),
      ),
    ).toMatchObject({ _tag: 'Found', newestAt: null, newestSinceMs: null })
  })
})
