import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { eq, inArray } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { feed, feedItem, pendingBlob } from '@spaces/db/schema'
import {
  FEED_IMAGE_GIVEN_UP,
  FEED_IMAGE_MAX_BYTES,
} from '@spaces/core/feeds/fetch'
import { storage } from '@spaces/core/writes/storage'
import {
  fetchFeedLogoProgram,
  fetchItemImagesProgram,
  photoRetryIdsProgram,
} from './images'
import { pollFeedProgram, pruneFeedItemsProgram } from './poll'
import { pictureOf, stubSite } from './fixtures'

/**
 * A feed's pictures against a stubbed web, the real local store and this
 * worker's test database: what is stored, what is skipped, what a logo is
 * found from, and what the daily delete takes with it.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const shaOf = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

const HOUR = 60 * 60 * 1000

let n = 0
const aFeed = async (siteUrl: string | null = null) => {
  n += 1
  const row = (
    await db
      .insert(feed)
      .values({
        url: `https://pics.example/feed/${String(n)}`,
        name: 'P',
        siteUrl,
      })
      .returning({ id: feed.id, url: feed.url })
  ).at(0)
  if (row === undefined) throw new Error('no feed')
  return row
}

const anItem = async (
  feedId: string,
  key: string,
  imageUrl: string | null,
  publishedAt = new Date(),
) => {
  const row = (
    await db
      .insert(feedItem)
      .values({ feedId, key, title: key, imageUrl, publishedAt })
      .returning({ id: feedItem.id })
  ).at(0)
  if (row === undefined) throw new Error('no item')
  return row.id
}

const itemOf = async (id: string) =>
  (await db.select().from(feedItem).where(eq(feedItem.id, id))).at(0)

const logoOf = async (id: string) =>
  (await db.select({ sha: feed.logoSha }).from(feed).where(eq(feed.id, id))).at(
    0,
  )?.sha

const pendingFor = (shas: ReadonlyArray<string>) =>
  db
    .select()
    .from(pendingBlob)
    .where(inArray(pendingBlob.sha, [...shas]))

const image =
  (bytes: Uint8Array, type = 'image/png') =>
  () => ({
    status: 200,
    headers: { 'content-type': type },
    body: bytes,
  })

describe('fetchItemImagesProgram', () => {
  it('stores an enclosure photo the poll handed over, and spends its intent', async () => {
    const f = await aFeed()
    const photo = pictureOf('jpeg')
    const requests = stubSite({
      [f.url]: () => ({
        status: 200,
        body: `<rss version="2.0"><channel><title>P</title><link>https://pics.example/</link><item><guid>a</guid><title>A</title><enclosure url="https://cdn.pics.example/a.jpg" type="image/jpeg" length="1"/></item></channel></rss>`,
      }),
      'https://cdn.pics.example/a.jpg': image(photo, 'image/jpeg'),
    })

    const polled = await Effect.runPromise(pollFeedProgram(f.id))
    if (polled._tag !== 'Fetched') throw new Error('expected a fetch')
    // The poll fetched the feed and nothing else: the photo is its own job.
    expect(requests.map((r) => r.url)).toEqual([f.url])
    expect(polled.withImages).toHaveLength(1)

    const out = await Effect.runPromise(
      fetchItemImagesProgram(polled.withImages),
    )
    expect(out).toEqual({ stored: 1, skipped: 0 })
    const id = polled.withImages.at(0) ?? ''
    expect((await itemOf(id))?.imageSha).toBe(shaOf(photo))
    expect(await storage().exists(shaOf(photo))).toBe(true)
    expect(await pendingFor([shaOf(photo)])).toEqual([])
    const asked = requests.at(-1)
    expect(asked?.headers.get('accept')).toMatch(/^image\//)
  })

  it('skips a photo over the cap and a page that is not an image; both items still land', async () => {
    const f = await aFeed()
    const big = pictureOf('png', FEED_IMAGE_MAX_BYTES + 1)
    stubSite({
      'https://cdn.pics.example/big.png': image(big),
      'https://cdn.pics.example/page.jpg': () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html>not a photo</html>',
      }),
    })
    const ids = [
      await anItem(f.id, 'big', 'https://cdn.pics.example/big.png'),
      await anItem(f.id, 'page', 'https://cdn.pics.example/page.jpg'),
    ]

    const out = await Effect.runPromise(fetchItemImagesProgram(ids))

    expect(out).toEqual({ stored: 0, skipped: 2 })
    for (const id of ids) {
      const row = await itemOf(id)
      expect(row?.imageSha).toBeNull()
      // Bytes judged not a photo stay that way: given up at once.
      expect(row?.imageFailures).toBe(FEED_IMAGE_GIVEN_UP)
    }
    expect(await storage().exists(shaOf(big))).toBe(false)
  })

  it('counts a failure that may pass, retries it once due, and stores it then', async () => {
    const f = await aFeed()
    const photo = pictureOf('png')
    let up = false
    const requests = stubSite({
      'https://cdn.pics.example/flaky.png': () =>
        up
          ? {
              status: 200,
              headers: { 'content-type': 'image/png' },
              body: photo,
            }
          : { status: 503 },
    })
    const id = await anItem(f.id, 'flaky', 'https://cdn.pics.example/flaky.png')
    const t0 = new Date('2026-11-17T08:00:00Z')

    expect(await Effect.runPromise(fetchItemImagesProgram([id], t0))).toEqual({
      stored: 0,
      skipped: 1,
    })
    expect(await itemOf(id)).toMatchObject({
      imageSha: null,
      imageFailures: 1,
      imageFailedAt: t0,
    })

    // Not yet due: nothing is asked for and nothing is counted.
    const early = new Date(t0.getTime() + HOUR - 1)
    expect(await Effect.runPromise(photoRetryIdsProgram(early))).toEqual([])
    await Effect.runPromise(fetchItemImagesProgram([id], early))
    expect(requests).toHaveLength(1)
    expect((await itemOf(id))?.imageFailures).toBe(1)

    const due = new Date(t0.getTime() + HOUR)
    expect(await Effect.runPromise(photoRetryIdsProgram(due))).toEqual([id])
    up = true
    expect(await Effect.runPromise(fetchItemImagesProgram([id], due))).toEqual({
      stored: 1,
      skipped: 0,
    })
    expect(requests).toHaveLength(2)
    expect((await itemOf(id))?.imageSha).toBe(shaOf(photo))
    expect(await Effect.runPromise(photoRetryIdsProgram(due))).toEqual([])
  })

  it('backs off 1h, 6h, 24h, then gives up for good', async () => {
    const f = await aFeed()
    const requests = stubSite({
      'https://cdn.pics.example/down.png': () => ({ status: 503 }),
    })
    const id = await anItem(f.id, 'down', 'https://cdn.pics.example/down.png')
    let at = new Date('2026-11-17T08:00:00Z')
    await Effect.runPromise(fetchItemImagesProgram([id], at))

    for (const [hours, failures] of [
      [1, 2],
      [6, 3],
      [24, FEED_IMAGE_GIVEN_UP],
    ] as const) {
      const before = new Date(at.getTime() + hours * HOUR - 1)
      expect(await Effect.runPromise(photoRetryIdsProgram(before))).toEqual([])
      at = new Date(at.getTime() + hours * HOUR)
      expect(await Effect.runPromise(photoRetryIdsProgram(at))).toEqual([id])
      await Effect.runPromise(fetchItemImagesProgram([id], at))
      expect(await itemOf(id)).toMatchObject({
        imageFailures: failures,
        imageFailedAt: at,
      })
    }

    const much = new Date(at.getTime() + 1000 * HOUR)
    expect(await Effect.runPromise(photoRetryIdsProgram(much))).toEqual([])
    await Effect.runPromise(fetchItemImagesProgram([id], much))
    expect(requests).toHaveLength(4)
  })

  it('gives up at once on a 404, and never asks again', async () => {
    const f = await aFeed()
    const requests = stubSite({})
    const id = await anItem(f.id, 'gone', 'https://cdn.pics.example/gone.png')
    const t0 = new Date('2026-11-17T08:00:00Z')

    await Effect.runPromise(fetchItemImagesProgram([id], t0))
    expect((await itemOf(id))?.imageFailures).toBe(FEED_IMAGE_GIVEN_UP)
    const later = new Date(t0.getTime() + 1000 * HOUR)
    expect(await Effect.runPromise(photoRetryIdsProgram(later))).toEqual([])
    await Effect.runPromise(fetchItemImagesProgram([id], later))
    expect(requests).toHaveLength(1)
  })

  it('fetches a photo two headlines share once, and never one already stored', async () => {
    const f = await aFeed()
    const photo = pictureOf('png')
    const requests = stubSite({
      'https://cdn.pics.example/shared.png': image(photo),
    })
    const ids = [
      await anItem(f.id, 's1', 'https://cdn.pics.example/shared.png'),
      await anItem(f.id, 's2', 'https://cdn.pics.example/shared.png'),
    ]

    await Effect.runPromise(fetchItemImagesProgram(ids))
    await Effect.runPromise(fetchItemImagesProgram(ids))

    expect(requests).toHaveLength(1)
    for (const id of ids)
      expect((await itemOf(id))?.imageSha).toBe(shaOf(photo))
  })
})

describe('fetchFeedLogoProgram', () => {
  it('is the feed’s own image when it names one', async () => {
    const f = await aFeed('https://own.example/')
    const logo = pictureOf('png')
    stubSite({
      [f.url]: () => ({
        status: 200,
        body: `<rss version="2.0"><channel><title>P</title><link>https://own.example/</link><image><url>https://own.example/logo.png</url></image></channel></rss>`,
      }),
      'https://own.example/logo.png': image(logo),
    })

    const out = await Effect.runPromise(fetchFeedLogoProgram(f.id))

    expect(out).toMatchObject({
      _tag: 'Stored',
      from: 'https://own.example/logo.png',
    })
    expect(await logoOf(f.id)).toBe(shaOf(logo))
    expect(await pendingFor([shaOf(logo)])).toEqual([])
  })

  it('falls back to /favicon.ico for a feed with no image and a page with no icon', async () => {
    const f = await aFeed('https://fav.example/')
    const icon = pictureOf('ico')
    stubSite({
      [f.url]: () => ({
        status: 200,
        body: `<rss version="2.0"><channel><title>P</title><link>https://fav.example/</link></channel></rss>`,
      }),
      'https://fav.example/': () => ({
        status: 200,
        body: '<html><head><title>Fav</title></head></html>',
      }),
      'https://fav.example/favicon.ico': image(icon, 'image/x-icon'),
    })

    const out = await Effect.runPromise(fetchFeedLogoProgram(f.id))

    expect(out).toMatchObject({
      _tag: 'Stored',
      from: 'https://fav.example/favicon.ico',
    })
    expect(await logoOf(f.id)).toBe(shaOf(icon))
  })

  it('passes over an SVG icon to the next candidate', async () => {
    const f = await aFeed('https://svg.example/')
    const touch = pictureOf('png')
    stubSite({
      'https://svg.example/': () => ({
        status: 200,
        body: '<html><head><link rel="icon" href="/i.svg"><link rel="apple-touch-icon" href="/t.png"></head></html>',
      }),
      'https://svg.example/i.svg': () => ({
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      }),
      'https://svg.example/t.png': image(touch),
    })

    const out = await Effect.runPromise(fetchFeedLogoProgram(f.id))

    expect(out).toMatchObject({
      _tag: 'Stored',
      from: 'https://svg.example/t.png',
    })
  })

  it('is none for a site with no icon at all: the page draws the monogram', async () => {
    const f = await aFeed('https://bare.example/')
    stubSite({})

    const out = await Effect.runPromise(fetchFeedLogoProgram(f.id))

    expect(out).toEqual({ _tag: 'None', tried: 1 })
    expect(await logoOf(f.id)).toBeNull()
  })

  it('replaces a changed logo and reclaims the old one; finding none keeps the one stored', async () => {
    const f = await aFeed('https://moves.example/')
    const before = pictureOf('png')
    const after = pictureOf('png')
    stubSite({ 'https://moves.example/favicon.ico': image(before) })
    await Effect.runPromise(fetchFeedLogoProgram(f.id))
    expect(await logoOf(f.id)).toBe(shaOf(before))

    stubSite({ 'https://moves.example/favicon.ico': image(after) })
    const out = await Effect.runPromise(fetchFeedLogoProgram(f.id))

    expect(out).toMatchObject({ _tag: 'Stored', changed: true })
    expect(await logoOf(f.id)).toBe(shaOf(after))
    expect(await storage().exists(shaOf(before))).toBe(false)

    stubSite({})
    await Effect.runPromise(fetchFeedLogoProgram(f.id))
    expect(await logoOf(f.id)).toBe(shaOf(after))
  })

  it('is Gone for a feed removed while its logo was queued', async () => {
    expect(
      await Effect.runPromise(
        fetchFeedLogoProgram('00000000-0000-4000-8000-000000000000'),
      ),
    ).toEqual({ _tag: 'Gone' })
  })
})

describe('pruneFeedItemsProgram', () => {
  it('takes an old headline’s photo with it unless a kept row holds the same blob', async () => {
    const f = await aFeed()
    const lone = pictureOf('png')
    const shared = pictureOf('png')
    stubSite({
      'https://cdn.pics.example/lone.png': image(lone),
      'https://cdn.pics.example/shared-old.png': image(shared),
    })
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    const ids = [
      await anItem(f.id, 'lone', 'https://cdn.pics.example/lone.png', old),
      await anItem(f.id, 'old', 'https://cdn.pics.example/shared-old.png', old),
      await anItem(f.id, 'kept', 'https://cdn.pics.example/shared-old.png'),
    ]
    await Effect.runPromise(fetchItemImagesProgram(ids))

    const out = await Effect.runPromise(pruneFeedItemsProgram())

    expect(out).toEqual({ deleted: 2, reclaimed: 1 })
    expect(await storage().exists(shaOf(lone))).toBe(false)
    expect(await storage().exists(shaOf(shared))).toBe(true)
    expect(await pendingFor([shaOf(lone), shaOf(shared)])).toEqual([])
  })
})
