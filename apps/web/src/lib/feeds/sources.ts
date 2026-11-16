import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  max,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, feed, feedItem, feedSpace, space } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { itemRowsOf } from '@spaces/core/feeds/fetch'
import type { FeedItemRow } from '@spaces/core/feeds/fetch'
import { enqueue } from '#/lib/queue'
import { decodeCursor, encodeCursor } from '#/lib/views/paging'
import { resolveFeedProgram } from './fetch'
import type { FeedFetchFailed, ResolvedFeed } from './fetch'
import { FeedStoreFailed, deleteAndReclaimProgram } from './poll'
import { feedPictureUrlsProgram } from './images'

/**
 * The Feeds page's reads and writes: add, edit and remove a source, the
 * Sources table and the Headlines list. Workspace-wide: any member manages
 * any feed. Outside `lib/server/` so tests call them without a request.
 */

/** A refusal the feed window shows as it is. */
export class FeedRefused extends Schema.TaggedError<FeedRefused>()(
  'FeedRefused',
  { message: Schema.String },
) {}

export type FeedSpaceTag = { readonly id: string; readonly name: string }

/**
 * One row of the Sources table.
 * - `state`: `new` before the first fetch lands, `failing` while the last
 *   fetch failed (`lastError` says why), else `ok`.
 * - `logoUrl` is a short-lived URL on our own blob store, null until the
 *   worker stores a logo or when the site has none: the page draws the
 *   monogram then. Never the publisher's address.
 */
export type FeedSource = {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly siteUrl: string | null
  /** The stored logo's blob digest. */
  readonly logoSha: string | null
  readonly logoUrl: string | null
  readonly state: 'new' | 'ok' | 'failing'
  readonly lastFetchedAt: string | null
  readonly lastSuccessAt: string | null
  readonly lastError: string | null
  readonly spaces: ReadonlyArray<FeedSpaceTag>
  readonly headlineCount: number
  /** The newest kept headline's published time. */
  readonly newestAt: string | null
  readonly createdAt: string
}

/**
 * One story in the Headlines list and the reader beside it.
 * - `logoUrl` and `photoUrl` are short-lived URLs on our own blob store;
 *   the address the feed named the photo at is never handed to a page, so
 *   no page can load it from the publisher.
 */
export type Headline = {
  readonly id: string
  readonly feedId: string
  readonly feedName: string
  readonly siteUrl: string | null
  /** The source's stored logo digest. */
  readonly logoSha: string | null
  readonly logoUrl: string | null
  readonly title: string
  /** The article, which the reader links to and never fetches. */
  readonly url: string | null
  /** Plain paragraphs split by a blank line: the reader's body. */
  readonly summary: string | null
  readonly publishedAt: string
  /** The stored photo's digest, null until the worker stores one. */
  readonly imageSha: string | null
  readonly photoUrl: string | null
}

export type HeadlinePage = {
  readonly headlines: ReadonlyArray<Headline>
  /** Hand back for the next page; null at the end. */
  readonly nextCursor: string | null
}

/** What Add feed found: the source as saved and its newest story. */
export type AddedFeed = {
  readonly source: FeedSource
  readonly newest: {
    readonly title: string
    readonly url: string | null
    readonly publishedAt: string
  } | null
}

export const HEADLINE_PAGE_SIZE = 30
export const HEADLINE_PAGE_MAX = 100

const store = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new FeedStoreFailed({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const iso = (d: Date | null): string | null =>
  d === null ? null : d.toISOString()

/** The feed's first fetch and its logo, now; one of each queued per feed. */
const enqueueFetch = (feedId: string) =>
  Effect.promise(async () => {
    await enqueue(QUEUES.feedFetch, { feedId }, { singletonKey: feedId })
    await enqueue(QUEUES.feedLogo, { feedId }, { singletonKey: feedId })
  })

const unknownSpaces = Effect.fn('feeds.unknownSpaces')(function* (
  spaceIds: ReadonlyArray<string>,
) {
  if (spaceIds.length === 0) return false
  const found = yield* store(() =>
    db
      .select({ id: space.entityId })
      .from(space)
      .where(inArray(space.entityId, [...spaceIds])),
  )
  return found.length !== new Set(spaceIds).size
})

/** The Sources rows, every feed or the ones in `ids`, by name. */
const sourcesProgram = Effect.fn('feeds.sources')(function* (
  ids?: ReadonlyArray<string>,
) {
  const only = ids === undefined ? undefined : inArray(feed.id, [...ids])
  const rows = yield* store(() =>
    db
      .select()
      .from(feed)
      .where(only)
      .orderBy(asc(sql`lower(${feed.name})`), asc(feed.id)),
  )
  if (rows.length === 0) return []
  const feedIds = rows.map((r) => r.id)
  const counts = yield* store(() =>
    db
      .select({
        feedId: feedItem.feedId,
        n: count(),
        newest: max(feedItem.publishedAt),
      })
      .from(feedItem)
      .where(inArray(feedItem.feedId, feedIds))
      .groupBy(feedItem.feedId),
  )
  const tags = yield* store(() =>
    db
      .select({
        feedId: feedSpace.feedId,
        id: feedSpace.spaceId,
        name: entity.canonicalName,
      })
      .from(feedSpace)
      .innerJoin(entity, eq(entity.id, feedSpace.spaceId))
      .where(inArray(feedSpace.feedId, feedIds))
      .orderBy(asc(entity.canonicalName)),
  )
  const countOf = new Map(counts.map((c) => [c.feedId, c]))
  const logos = yield* feedPictureUrlsProgram(rows.map((r) => r.logoSha))
  return rows.map((r): FeedSource => {
    const c = countOf.get(r.id)
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      siteUrl: r.siteUrl,
      logoSha: r.logoSha,
      logoUrl: r.logoSha === null ? null : (logos.get(r.logoSha) ?? null),
      state:
        r.lastStatus === 'failed'
          ? 'failing'
          : r.lastStatus === null
            ? 'new'
            : 'ok',
      lastFetchedAt: iso(r.lastFetchedAt),
      lastSuccessAt: iso(r.lastSuccessAt),
      lastError: r.lastError,
      spaces: tags
        .filter((t) => t.feedId === r.id)
        .map((t) => ({ id: t.id, name: t.name })),
      headlineCount: c?.n ?? 0,
      newestAt: iso(c?.newest ?? null),
      createdAt: r.createdAt.toISOString(),
    }
  })
})

/** Every feed with its state, spaces and counts: the Sources table. */
export const listFeedSourcesProgram = Effect.fn('feeds.listSources')(
  function* (): Effect.fn.Return<ReadonlyArray<FeedSource>, FeedStoreFailed> {
    return yield* sourcesProgram()
  },
)

const oneSource = Effect.fn('feeds.oneSource')(function* (id: string) {
  const found = (yield* sourcesProgram([id])).at(0)
  if (found === undefined)
    return yield* new FeedRefused({ message: 'That feed is gone' })
  return found
})

const takenBy = Effect.fn('feeds.takenBy')(function* (
  url: string,
  except: string | null,
) {
  const rows = yield* store(() =>
    db
      .select({ name: feed.name })
      .from(feed)
      .where(
        except === null
          ? eq(feed.url, url)
          : and(eq(feed.url, url), ne(feed.id, except)),
      ),
  )
  return rows.at(0)?.name ?? null
})

const hostOf = (url: string): string =>
  new URL(url).hostname.replace(/^www\./, '')

const siteOf = (resolved: ResolvedFeed): string =>
  resolved.feed.siteUrl ?? new URL(resolved.typedUrl).origin

/**
 * Add feed: the address resolved to its feed and fetched once, the row
 * saved under the feed's own name, tagged, and its first fetch and its logo
 * sent at once so its headlines land without waiting for the clock.
 */
export const addFeedProgram = Effect.fn('feeds.add')(function* (
  actorId: string,
  data: { readonly address: string; readonly spaceIds: ReadonlyArray<string> },
): Effect.fn.Return<
  AddedFeed,
  FeedRefused | FeedFetchFailed | FeedStoreFailed
> {
  if (yield* unknownSpaces(data.spaceIds))
    return yield* new FeedRefused({ message: 'A chosen space is gone' })
  const resolved = yield* resolveFeedProgram(data.address)
  const taken = yield* takenBy(resolved.url, null)
  if (taken !== null)
    return yield* new FeedRefused({ message: `Already a source: ${taken}` })

  const id = yield* store(() =>
    db.transaction(async (tx) => {
      const row = (
        await tx
          .insert(feed)
          .values({
            url: resolved.url,
            siteUrl: siteOf(resolved),
            name: resolved.feed.title ?? hostOf(siteOf(resolved)),
            addedBy: actorId,
          })
          .returning({ id: feed.id })
      ).at(0)
      if (row === undefined) throw new Error('the feed row was not written')
      if (data.spaceIds.length > 0)
        await tx.insert(feedSpace).values(
          [...new Set(data.spaceIds)].map((spaceId) => ({
            feedId: row.id,
            spaceId,
          })),
        )
      return row.id
    }),
  )
  yield* enqueueFetch(id)

  const newest = itemRowsOf(
    resolved.feed.items,
    new Date(),
  ).reduce<FeedItemRow | null>(
    (best, r) =>
      best === null || r.publishedAt.getTime() > best.publishedAt.getTime()
        ? r
        : best,
    null,
  )
  return {
    source: yield* oneSource(id),
    newest:
      newest === null
        ? null
        : {
            title: newest.title,
            url: newest.url,
            publishedAt: newest.publishedAt.toISOString(),
          },
  }
})

/**
 * Edit a feed: its address, its name, its spaces, any of the three.
 * - A new address is resolved like an added one; the fetch state and the
 *   validators start over and a fetch and a logo are sent at once. Kept
 *   headlines stay.
 * - `spaceIds` replaces the tags.
 */
export const editFeedProgram = Effect.fn('feeds.edit')(function* (data: {
  readonly id: string
  readonly address?: string | undefined
  readonly name?: string | undefined
  readonly spaceIds?: ReadonlyArray<string> | undefined
}): Effect.fn.Return<
  FeedSource,
  FeedRefused | FeedFetchFailed | FeedStoreFailed
> {
  const current = yield* oneSource(data.id)
  if (data.spaceIds !== undefined && (yield* unknownSpaces(data.spaceIds)))
    return yield* new FeedRefused({ message: 'A chosen space is gone' })

  const resolved =
    data.address === undefined || data.address.trim() === current.url
      ? null
      : yield* resolveFeedProgram(data.address)
  const moved =
    resolved !== null && resolved.url !== current.url ? resolved : null
  if (moved !== null) {
    const taken = yield* takenBy(moved.url, data.id)
    if (taken !== null)
      return yield* new FeedRefused({ message: `Already a source: ${taken}` })
  }

  yield* store(() =>
    db.transaction(async (tx) => {
      const set = {
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(moved !== null
          ? {
              url: moved.url,
              siteUrl: siteOf(moved),
              etag: null,
              lastModified: null,
              lastStatus: null,
              lastError: null,
              lastFetchedAt: null,
              lastSuccessAt: null,
            }
          : {}),
      }
      if (Object.keys(set).length > 0)
        await tx.update(feed).set(set).where(eq(feed.id, data.id))
      if (data.spaceIds !== undefined) {
        await tx.delete(feedSpace).where(eq(feedSpace.feedId, data.id))
        if (data.spaceIds.length > 0)
          await tx.insert(feedSpace).values(
            [...new Set(data.spaceIds)].map((spaceId) => ({
              feedId: data.id,
              spaceId,
            })),
          )
      }
    }),
  )
  if (moved !== null) yield* enqueueFetch(data.id)
  return yield* oneSource(data.id)
})

/**
 * Remove a feed, its tags and its headlines, and the logo and photos they
 * held unless another row holds the same blob. Removing a gone feed is a
 * no-op.
 */
export const removeFeedProgram = Effect.fn('feeds.remove')(function* (
  id: string,
) {
  const { deleted } = yield* deleteAndReclaimProgram(
    async (tx) => {
      // The headlines' digests are read before the cascade takes the rows.
      const photos = await tx
        .select({ sha: feedItem.imageSha })
        .from(feedItem)
        .where(eq(feedItem.feedId, id))
      const gone = await tx
        .delete(feed)
        .where(eq(feed.id, id))
        .returning({ logoSha: feed.logoSha })
      return gone.map((g) => [g.logoSha, ...photos.map((p) => p.sha)])
    },
    (shas) => shas,
  )
  return { removed: deleted > 0 }
})

/** `timestamptz::text` under the ISO date style: `2026-11-16 12:00:00.5+00`. */
const PG_TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}(?::\d{2})?$/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A cursor this list cut, or null: a forged one must not reach a cast. */
const cursorOf = (
  raw: string | undefined,
): { readonly id: string; readonly k: string } | null => {
  const c = raw === undefined ? null : decodeCursor(raw)
  if (c === null || c.k === null || !UUID.test(c.id)) return null
  return PG_TIMESTAMPTZ.test(c.k) ? { id: c.id, k: c.k } : null
}

/**
 * Headlines, newest first, a page at a time.
 * - `spaceId` keeps the feeds tagged to that space or any space under it.
 * - The cursor is opaque; an unreadable one is page one.
 */
export const listHeadlinesProgram = Effect.fn('feeds.listHeadlines')(
  function* (query: {
    readonly spaceId?: string | undefined
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
  }): Effect.fn.Return<HeadlinePage, FeedStoreFailed> {
    const limit = Math.max(
      1,
      Math.min(query.limit ?? HEADLINE_PAGE_SIZE, HEADLINE_PAGE_MAX),
    )
    const after = cursorOf(query.cursor)
    const where: Array<SQL> = []
    if (query.spaceId !== undefined)
      where.push(
        inArray(
          feedItem.feedId,
          db
            .select({ id: feedSpace.feedId })
            .from(feedSpace)
            .innerJoin(space, eq(space.entityId, feedSpace.spaceId))
            .where(
              sql`${space.path} <@ (select path from ${space} where entity_id = ${query.spaceId})`,
            ),
        ),
      )
    if (after !== null) {
      const at = sql`${after.k}::timestamptz`
      const before = or(
        sql`${feedItem.publishedAt} < ${at}`,
        and(
          sql`${feedItem.publishedAt} = ${at}`,
          sql`${feedItem.id} < ${after.id}`,
        ),
      )
      if (before !== undefined) where.push(before)
    }
    const rows = yield* store(() =>
      db
        .select({
          id: feedItem.id,
          feedId: feedItem.feedId,
          feedName: feed.name,
          siteUrl: feed.siteUrl,
          logoSha: feed.logoSha,
          title: feedItem.title,
          url: feedItem.url,
          summary: feedItem.summary,
          publishedAt: feedItem.publishedAt,
          sortKey: sql<string>`${feedItem.publishedAt}::text`,
          imageSha: feedItem.imageSha,
        })
        .from(feedItem)
        .innerJoin(feed, eq(feed.id, feedItem.feedId))
        .where(and(...where))
        .orderBy(desc(feedItem.publishedAt), desc(feedItem.id))
        .limit(limit + 1),
    )
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const urls = yield* feedPictureUrlsProgram(
      page.flatMap((h) => [h.logoSha, h.imageSha]),
    )
    const urlOf = (sha: string | null) =>
      sha === null ? null : (urls.get(sha) ?? null)
    return {
      headlines: page.map(
        ({ sortKey: _sortKey, publishedAt, ...h }): Headline => ({
          ...h,
          logoUrl: urlOf(h.logoSha),
          publishedAt: publishedAt.toISOString(),
          photoUrl: urlOf(h.imageSha),
        }),
      ),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ id: last.id, k: last.sortKey })
          : null,
    }
  },
)
