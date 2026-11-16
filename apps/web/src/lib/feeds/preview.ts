import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { feed } from '@spaces/db/schema'
import { FEED_REASONS, itemRowsOf } from '@spaces/core/feeds/fetch'
import { resolveFeedProgram } from './fetch'
import { FeedStoreFailed } from './poll'

/**
 * What Add feed shows under its field before anything is saved: the feed an
 * address resolves to, or the sentence that says why it will not add. Reads
 * the site and the `feed` table; writes nothing.
 */

/**
 * - `Found`: the name Add would save, the feed's URL and its newest kept
 *   story's time, with its age measured here so the server and the browser
 *   print one string.
 * - `Refused`: the sentence the window prints in crimson; Add stays off.
 */
export type FeedPreview =
  | {
      readonly _tag: 'Found'
      readonly name: string
      readonly url: string
      readonly newestAt: string | null
      readonly newestSinceMs: number | null
    }
  | { readonly _tag: 'Refused'; readonly message: string }

/** The way out a page with no feed is offered. */
const NO_FEED_HINT = "Paste the site's address or its RSS link."

const sentence = (reason: string): string =>
  reason === FEED_REASONS.noFeed
    ? `${reason}. ${NO_FEED_HINT}`
    : reason.endsWith('.')
      ? reason
      : `${reason}.`

const hostOf = (url: string): string =>
  new URL(url).hostname.replace(/^www\./, '')

/** Add feed's look ahead: the feed `typed` resolves to, fetched once. */
export const previewFeedProgram = Effect.fn('feeds.preview')(function* (
  typed: string,
  now: Date,
): Effect.fn.Return<FeedPreview, FeedStoreFailed> {
  const resolved = yield* resolveFeedProgram(typed).pipe(
    Effect.catchTag('FeedFetchFailed', (e) =>
      Effect.succeed({
        _tag: 'Refused' as const,
        message: sentence(e.message),
      }),
    ),
  )
  if ('_tag' in resolved) return resolved

  const taken = yield* Effect.tryPromise({
    try: () =>
      db
        .select({ name: feed.name })
        .from(feed)
        .where(eq(feed.url, resolved.url))
        .limit(1),
    catch: (cause) =>
      new FeedStoreFailed({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })
  const already = taken.at(0)
  if (already !== undefined)
    return { _tag: 'Refused', message: `Already a source: ${already.name}.` }

  const newest = itemRowsOf(resolved.feed.items, now).reduce<Date | null>(
    (best, r) =>
      best === null || r.publishedAt.getTime() > best.getTime()
        ? r.publishedAt
        : best,
    null,
  )
  const site = resolved.feed.siteUrl ?? new URL(resolved.typedUrl).origin
  return {
    _tag: 'Found',
    name: resolved.feed.title ?? hostOf(site),
    url: resolved.url,
    newestAt: newest === null ? null : newest.toISOString(),
    newestSinceMs:
      newest === null ? null : Math.max(0, now.getTime() - newest.getTime()),
  }
})
