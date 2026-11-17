import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, feed, feedItem, feedSpace, space } from '@spaces/db/schema'
import { spaceFeedsProgram, todayHeadlinesProgram } from './elsewhere'

/**
 * A space's feeds and newest headlines, and Today's count, against this
 * worker's test database (truncated before the file).
 */

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
  const slug = `e${String(n)}`
  const path = parentPath === undefined ? slug : `${parentPath}.${slug}`
  await db.insert(space).values({ entityId: ent.id, slug, path })
  return { id: ent.id, path }
}

const aFeed = async (
  name: string,
  spaceIds: ReadonlyArray<string>,
  over: { lastStatus?: 'ok' | 'failed'; lastError?: string } = {},
) => {
  const row = (
    await db
      .insert(feed)
      .values({
        name,
        url: `https://${name.toLowerCase().replace(/\W/g, '')}.example/feed`,
        lastStatus: over.lastStatus ?? 'ok',
        lastError: over.lastError ?? null,
      })
      .returning({ id: feed.id })
  ).at(0)
  if (row === undefined) throw new Error('no feed')
  for (const spaceId of spaceIds)
    await db.insert(feedSpace).values({ feedId: row.id, spaceId })
  return row.id
}

const items = async (
  feedId: string,
  stories: ReadonlyArray<{
    title: string
    at: string
    seen?: string
    summary?: string
  }>,
) => {
  await db.insert(feedItem).values(
    stories.map((s) => ({
      feedId,
      key: s.title,
      title: s.title,
      summary: s.summary ?? null,
      url: `https://news.example/${encodeURIComponent(s.title)}`,
      publishedAt: new Date(s.at),
      firstSeenAt: new Date(s.seen ?? s.at),
    })),
  )
}

describe('spaceFeedsProgram', () => {
  it("reads the feeds of the space and its subspaces, and each feed's newest two headlines", async () => {
    const root = await aSpace('Launch')
    const sub = await aSpace('Small launchers', root.path)
    const other = await aSpace('Proptech')
    const spaceNews = await aFeed('SpaceNews', [root.id])
    const inc42 = await aFeed('Inc42', [sub.id], {
      lastStatus: 'failed',
      lastError: 'The site answered 404',
    })
    const elsewhere = await aFeed('Elsewhere', [other.id])
    await items(spaceNews, [
      {
        title: 'Skyroot fires',
        at: '2026-11-16T09:00:00Z',
        summary: 'The third stage burned in full.\n\nA second paragraph.',
      },
      { title: 'Agnikul pad', at: '2026-11-15T10:00:00Z' },
      { title: 'Oldest news', at: '2026-11-10T09:00:00Z' },
    ])
    await items(inc42, [
      { title: 'IN-SPACe licences', at: '2026-11-08T09:00:00Z' },
    ])
    await items(elsewhere, [
      { title: 'Not this space', at: '2026-11-16T12:00:00Z' },
    ])

    const got = await Effect.runPromise(spaceFeedsProgram(root.id))
    // Newest story first, the failing feed last.
    expect(got.feeds.map((f) => [f.name, f.state])).toEqual([
      ['SpaceNews', 'ok'],
      ['Inc42', 'failing'],
    ])
    // A busy feed keeps its newest two: Inc42's older story still shows.
    expect(got.headlines.map((h) => [h.title, h.feedName])).toEqual([
      ['Skyroot fires', 'SpaceNews'],
      ['Agnikul pad', 'SpaceNews'],
      ['IN-SPACe licences', 'Inc42'],
    ])
    expect(got.headlines.at(0)?.publishedAt).toBe('2026-11-16T09:00:00.000Z')
    // The summary's lead only, for a one-line row; none reads null.
    expect(got.headlines.map((h) => h.summary)).toEqual([
      'The third stage burned in full.',
      null,
      null,
    ])

    // A subspace reads its own feed only, never its parent's.
    const below = await Effect.runPromise(spaceFeedsProgram(sub.id))
    expect(below.feeds.map((f) => f.name)).toEqual(['Inc42'])
  })

  it('reads nothing for a space no feed is tagged to', async () => {
    const lone = await aSpace('Quiet')
    expect(await Effect.runPromise(spaceFeedsProgram(lone.id))).toEqual({
      feeds: [],
      headlines: [],
    })
  })
})

describe('todayHeadlinesProgram', () => {
  it('counts headlines first seen in the day across every feed, the busiest feed first', async () => {
    const a = await aFeed('TechCrunch Daily', [])
    const b = await aFeed('Rest of World', [])
    // Each feed's first fetch, days before: the backfill under test below.
    await items(a, [{ title: 'Backfill A', at: '2026-11-10T09:00:00Z' }])
    await items(b, [{ title: 'Backfill B', at: '2026-11-10T09:00:00Z' }])
    await items(a, [
      // Published days ago, first seen today: it came in today.
      {
        title: 'Late arrival',
        at: '2026-11-01T09:00:00Z',
        seen: '2026-11-20T08:00:00Z',
      },
      { title: 'Morning', at: '2026-11-20T09:00:00Z' },
      { title: 'Yesterday', at: '2026-11-19T22:00:00Z' },
    ])
    await items(b, [{ title: 'Noon', at: '2026-11-20T12:00:00Z' }])
    const day = await Effect.runPromise(
      todayHeadlinesProgram(
        new Date('2026-11-20T00:00:00Z'),
        new Date('2026-11-21T00:00:00Z'),
      ),
    )
    expect(day).toEqual({
      count: 3,
      feeds: ['TechCrunch Daily', 'Rest of World'],
    })
    const none = await Effect.runPromise(
      todayHeadlinesProgram(
        new Date('2026-11-22T00:00:00Z'),
        new Date('2026-11-23T00:00:00Z'),
      ),
    )
    expect(none).toEqual({ count: 0, feeds: [] })
  })

  it("leaves a new feed's first fetch out as backfill, and counts what its next fetch brings", async () => {
    const added = await aFeed('The Ken', [])
    // A day of its own: the file's earlier rows stay until the next file.
    const firstFetch = '2026-11-25T08:00:00Z'
    // One fetch stamps all forty with the same instant.
    await items(
      added,
      Array.from({ length: 40 }, (_, i) => ({
        title: `Archive ${String(i)}`,
        at: `2026-11-${String(10 + (i % 10)).padStart(2, '0')}T09:00:00Z`,
        seen: firstFetch,
      })),
    )
    const day = () =>
      Effect.runPromise(
        todayHeadlinesProgram(
          new Date('2026-11-25T00:00:00Z'),
          new Date('2026-11-26T00:00:00Z'),
        ),
      )
    expect(await day()).toEqual({ count: 0, feeds: [] })

    // The half-hourly poll later the same day: two new stories.
    await items(added, [
      {
        title: 'Fresh one',
        at: '2026-11-25T08:20:00Z',
        seen: '2026-11-25T08:30:00Z',
      },
      {
        title: 'Fresh two',
        at: '2026-11-25T08:25:00Z',
        seen: '2026-11-25T08:30:00Z',
      },
    ])
    expect(await day()).toEqual({ count: 2, feeds: ['The Ken'] })
  })
})
