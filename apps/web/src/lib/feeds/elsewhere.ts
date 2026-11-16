import { Effect, Schema } from 'effect'
import { and, asc, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { feed, feedItem, feedSpace, space } from '@spaces/db/schema'
import { listFeedSourcesProgram } from './sources'
import type { FeedSource } from './sources'

/**
 * Feeds where a person already looks: a space's newest headlines and its
 * feeds for the space page's lanes, and Today's one line. Outside
 * `lib/server/` so tests call the programs without a request.
 */

export class ElsewhereFailed extends Schema.TaggedError<ElsewhereFailed>()(
  'ElsewhereFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ElsewhereFailed({ cause }),
  })

/**
 * How many headlines a space's What's moving holds: a busy feed never
 * pushes out the space's own news.
 */
export const SPACE_HEADLINES_MAX = 2

/** A headline as a space's What's moving lists it: the story over its source. */
export type SpaceHeadline = {
  readonly id: string
  readonly feedId: string
  readonly feedName: string
  readonly title: string
  /** The article, opened in a new tab. */
  readonly url: string | null
  readonly publishedAt: string
}

export type SpaceFeeds = {
  /**
   * The feeds tagged to the space or a space under it: newest story first,
   * a failing feed last.
   */
  readonly feeds: ReadonlyArray<FeedSource>
  /** Their newest headlines, at most `SPACE_HEADLINES_MAX`, newest first. */
  readonly headlines: ReadonlyArray<SpaceHeadline>
}

/**
 * The feeds of a space and its subspaces, and their newest headlines. The
 * subtree is the scope What's moving reads signals over, and the one the
 * Feeds page's space filter keeps.
 */
export const spaceFeedsProgram = Effect.fn('feeds.spaceFeeds')(function* (
  spaceId: string,
): Effect.fn.Return<SpaceFeeds, ElsewhereFailed> {
  const tagged = yield* query(() =>
    db
      .selectDistinct({ feedId: feedSpace.feedId })
      .from(feedSpace)
      .innerJoin(space, eq(space.entityId, feedSpace.spaceId))
      .where(
        sql`${space.path} <@ (select path from ${space} where entity_id = ${spaceId})`,
      ),
  )
  if (tagged.length === 0) return { feeds: [], headlines: [] }
  const ids = tagged.map((t) => t.feedId)
  const [sources, rows] = yield* Effect.all(
    [
      listFeedSourcesProgram().pipe(
        Effect.mapError((cause) => new ElsewhereFailed({ cause })),
      ),
      query(() =>
        db
          .select({
            id: feedItem.id,
            feedId: feedItem.feedId,
            feedName: feed.name,
            title: feedItem.title,
            url: feedItem.url,
            publishedAt: feedItem.publishedAt,
          })
          .from(feedItem)
          .innerJoin(feed, eq(feed.id, feedItem.feedId))
          .where(inArray(feedItem.feedId, ids))
          .orderBy(desc(feedItem.publishedAt), desc(feedItem.id))
          .limit(SPACE_HEADLINES_MAX),
      ),
    ],
    { concurrency: 'unbounded' },
  )
  const mine = new Set(ids)
  return {
    feeds: sources
      .filter((s) => mine.has(s.id))
      .sort(
        (x, y) =>
          Number(x.state === 'failing') - Number(y.state === 'failing') ||
          (y.newestAt ?? '').localeCompare(x.newestAt ?? ''),
      ),
    headlines: rows.map((r) => ({
      ...r,
      publishedAt: r.publishedAt.toISOString(),
    })),
  }
})

/** Today's line: how many headlines came in, and the feeds they came from. */
export type TodayHeadlines = {
  readonly count: number
  /** Feed names, the most headlines first. */
  readonly feeds: ReadonlyArray<string>
}

/**
 * Headlines first seen in `[from, to)` across every feed. The caller hands
 * in the reader's day, as the Today page reads it.
 */
export const todayHeadlinesProgram = Effect.fn('feeds.todayHeadlines')(
  function* (
    from: Date,
    to: Date,
  ): Effect.fn.Return<TodayHeadlines, ElsewhereFailed> {
    const n = count()
    const rows = yield* query(() =>
      db
        .select({ name: feed.name, n })
        .from(feedItem)
        .innerJoin(feed, eq(feed.id, feedItem.feedId))
        .where(
          and(gte(feedItem.firstSeenAt, from), lt(feedItem.firstSeenAt, to)),
        )
        .groupBy(feed.id, feed.name)
        .orderBy(desc(n), asc(sql`lower(${feed.name})`)),
    )
    return {
      count: rows.reduce((sum, r) => sum + r.n, 0),
      feeds: rows.map((r) => r.name),
    }
  },
)
