import { Readable } from 'node:stream'
import { Effect } from 'effect'
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import { feed, feedItem, pendingBlob } from '@spaces/db/schema'
import { judgePicture } from '@spaces/core/enrichment/picture'
import { iconLinksOf } from '@spaces/core/feeds/feed'
import {
  FEED_IMAGE_ACCEPT,
  FEED_IMAGE_CONCURRENCY,
  FEED_IMAGE_GIVEN_UP,
  FEED_IMAGE_MAX_BYTES,
  FEED_IMAGE_RETRIES_PER_POLL,
  FEED_IMAGE_TIMEOUT_MS,
  FEED_LOGO_MAX_BYTES,
  FEED_MAX_BYTES,
  FEED_TIMEOUT_MS,
  fetchFailureOf,
  photoFetchDue,
  photoRetryCutoffs,
} from '@spaces/core/feeds/fetch'
import { putBlobProgram } from '@spaces/core/writes/documents/intake'
import { guardedFetchProgram } from '#/lib/documents/fetch-guard'
import { pictureUrlProgram } from '#/lib/records/pictures'
import { FEED_USER_AGENT, NO_VALIDATORS, fetchFeedProgram } from './fetch'
import { FeedStoreFailed, reclaimFeedBlobsProgram } from './poll'

/**
 * A feed's pictures: headline photos and source logos fetched by the worker
 * through the URL guard, judged by their bytes and stored as blobs, and the
 * short-lived URLs a page draws them from. Nothing a page renders points at
 * a publisher, so reading Feeds tells no publisher who reads what.
 * - A new blob keeps its `pending_blob` row until the feed or headline row
 *   names it; a row gone meanwhile leaves the bytes to the orphan sweep.
 * - Outside `lib/server/` so the worker and tests call it without a request.
 */

const store = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new FeedStoreFailed({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const storeFailed = (cause: { readonly _tag: string }) =>
  new FeedStoreFailed({ cause, message: `could not store (${cause._tag})` })

type Pictured =
  | { readonly _tag: 'Stored'; readonly sha: string }
  | {
      readonly _tag: 'Skipped'
      readonly reason: string
      /** No later try can change it: the feed fetch's own non-retry rule. */
      readonly final: boolean
    }

/**
 * One picture fetched and stored under `maxBytes`, or why not: refused by
 * the guard, unreachable, over the cap, or not a raster image by its bytes.
 * Only the store failing is a failure. Bytes that were read and judged not
 * a picture (AVIF included) are final.
 */
const storePicture = Effect.fn('feeds.storePicture')(function* (
  url: string,
  maxBytes: number,
): Effect.fn.Return<Pictured, FeedStoreFailed> {
  const res = yield* guardedFetchProgram(url, {
    maxBytes,
    timeoutMs: FEED_IMAGE_TIMEOUT_MS,
    headers: { accept: FEED_IMAGE_ACCEPT, 'user-agent': FEED_USER_AGENT },
  })
  if (!res.ok)
    return {
      _tag: 'Skipped',
      reason: res.reason,
      final: !fetchFailureOf(res).retryable,
    }
  const judged = judgePicture(res.contentType, res.bytes, maxBytes)
  if (!judged.ok) return { _tag: 'Skipped', reason: judged.why, final: true }
  const { sha } = yield* putBlobProgram({
    stream: Readable.from(Buffer.from(res.bytes)),
    mime: judged.type,
    preparedBy: null,
  }).pipe(Effect.mapError(storeFailed))
  return { _tag: 'Stored', sha }
})

export type FeedImagesFetched = {
  readonly stored: number
  readonly skipped: number
}

/**
 * The photos of `itemIds` that name one, have none stored yet and are due
 * at `now` by `photoFetchDue`. A photo two headlines share is fetched once.
 * A skipped photo is counted on its headlines with the instant, so the
 * poll tries it again later; a final refusal gives up at once.
 */
export const fetchItemImagesProgram = Effect.fn('feeds.fetchItemImages')(
  function* (
    itemIds: ReadonlyArray<string>,
    now: Date = new Date(),
  ): Effect.fn.Return<FeedImagesFetched, FeedStoreFailed> {
    if (itemIds.length === 0) return { stored: 0, skipped: 0 }
    const rows = yield* store(() =>
      db
        .select({
          id: feedItem.id,
          imageUrl: feedItem.imageUrl,
          failures: feedItem.imageFailures,
          failedAt: feedItem.imageFailedAt,
        })
        .from(feedItem)
        .where(
          and(
            inArray(feedItem.id, [...itemIds]),
            isNull(feedItem.imageSha),
            isNotNull(feedItem.imageUrl),
          ),
        ),
    )
    const byUrl = new Map<string, Array<string>>()
    for (const r of rows) {
      if (r.imageUrl === null) continue
      if (!photoFetchDue(r.failures, r.failedAt, now)) continue
      byUrl.set(r.imageUrl, [...(byUrl.get(r.imageUrl) ?? []), r.id])
    }
    const outcomes = yield* Effect.forEach(
      [...byUrl],
      ([url, ids]) =>
        storePicture(url, FEED_IMAGE_MAX_BYTES).pipe(
          Effect.flatMap((pictured) =>
            pictured._tag === 'Skipped'
              ? setItemFailed(ids, pictured.final, now).pipe(Effect.as(false))
              : setItemImage(ids, pictured.sha).pipe(Effect.as(true)),
          ),
        ),
      { concurrency: FEED_IMAGE_CONCURRENCY },
    )
    const stored = outcomes.filter((o) => o).length
    return { stored, skipped: outcomes.length - stored }
  },
)

/**
 * One more failure on every headline still without the photo, or the
 * give-up count when no later try can change the answer.
 */
const setItemFailed = (ids: ReadonlyArray<string>, final: boolean, at: Date) =>
  store(() =>
    db
      .update(feedItem)
      .set({
        imageFailures: final
          ? FEED_IMAGE_GIVEN_UP
          : sql`${feedItem.imageFailures} + 1`,
        imageFailedAt: at,
      })
      .where(and(inArray(feedItem.id, [...ids]), isNull(feedItem.imageSha))),
  )

/**
 * Headlines whose failed photo is due another try at `now`, longest
 * waiting first, at most `limit`: what the half-hourly poll sends back to
 * `feed.images`. The query form of `photoFetchDue`.
 */
export const photoRetryIdsProgram = Effect.fn('feeds.photoRetryIds')(function* (
  now: Date = new Date(),
  limit: number = FEED_IMAGE_RETRIES_PER_POLL,
): Effect.fn.Return<ReadonlyArray<string>, FeedStoreFailed> {
  const due = or(
    ...photoRetryCutoffs(now).map(({ failures, failedBy }) =>
      and(
        eq(feedItem.imageFailures, failures),
        or(
          isNull(feedItem.imageFailedAt),
          lte(feedItem.imageFailedAt, failedBy),
        ),
      ),
    ),
  )
  const rows = yield* store(() =>
    db
      .select({ id: feedItem.id })
      .from(feedItem)
      .where(and(isNull(feedItem.imageSha), isNotNull(feedItem.imageUrl), due))
      .orderBy(asc(feedItem.imageFailedAt), asc(feedItem.id))
      .limit(limit),
  )
  return rows.map((r) => r.id)
})

/**
 * The digest on every headline still without a photo; the intent is spent
 * once one holds it.
 */
const setItemImage = (ids: ReadonlyArray<string>, sha: string) =>
  store(() =>
    db.transaction(async (tx) => {
      const took = await tx
        .update(feedItem)
        .set({ imageSha: sha })
        .where(and(inArray(feedItem.id, [...ids]), isNull(feedItem.imageSha)))
        .returning({ id: feedItem.id })
      if (took.length > 0)
        await tx.delete(pendingBlob).where(eq(pendingBlob.sha, sha))
    }),
  )

export type FeedLogoFetched =
  | { readonly _tag: 'Gone' }
  /** No candidate was an image; the stored logo, if any, stays. */
  | { readonly _tag: 'None'; readonly tried: number }
  | {
      readonly _tag: 'Stored'
      readonly sha: string
      readonly from: string
      readonly changed: boolean
    }

/** The site's page, for its icon links; empty when it cannot be read. */
const sitePage = Effect.fn('feeds.sitePage')(function* (site: string) {
  const res = yield* guardedFetchProgram(site, {
    maxBytes: FEED_MAX_BYTES,
    timeoutMs: FEED_TIMEOUT_MS,
    headers: {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'user-agent': FEED_USER_AGENT,
    },
  })
  // Link tags are ASCII whatever the page's charset.
  return res.ok
    ? { url: res.url, html: new TextDecoder('utf-8').decode(res.bytes) }
    : { url: site, html: '' }
})

/**
 * One source's logo, tried best first until one is an image: the feed's
 * own image, then the site's `<link rel="icon">`, `apple-touch-icon` and
 * `/favicon.ico`. A logo it replaces is reclaimed once no row names it.
 * Finding none keeps the stored logo: a site that is down this week has
 * not dropped its icon.
 */
export const fetchFeedLogoProgram = Effect.fn('feeds.fetchLogo')(function* (
  feedId: string,
): Effect.fn.Return<FeedLogoFetched, FeedStoreFailed> {
  const row = (yield* store(() =>
    db
      .select({ url: feed.url, siteUrl: feed.siteUrl })
      .from(feed)
      .where(eq(feed.id, feedId)),
  )).at(0)
  if (row === undefined) return { _tag: 'Gone' }

  const own = yield* fetchFeedProgram(row.url, NO_VALIDATORS).pipe(
    Effect.map((f) => (f._tag === 'Fetched' ? f.feed.imageUrl : null)),
    Effect.orElseSucceed(() => null),
  )
  const page = yield* sitePage(row.siteUrl ?? new URL('/', row.url).toString())
  const candidates = [
    ...new Set([
      ...(own === null ? [] : [own]),
      ...iconLinksOf(page.html, page.url),
    ]),
  ]

  for (const candidate of candidates) {
    const pictured = yield* storePicture(candidate, FEED_LOGO_MAX_BYTES)
    if (pictured._tag === 'Skipped') continue
    const written = yield* setLogo(feedId, pictured.sha)
    if (written === null) return { _tag: 'Gone' }
    if (written.previous !== null && written.previous !== pictured.sha)
      yield* reclaimFeedBlobsProgram([written.previous])
    return {
      _tag: 'Stored',
      sha: pictured.sha,
      from: candidate,
      changed: written.previous !== pictured.sha,
    }
  }
  return { _tag: 'None', tried: candidates.length }
})

/**
 * The digest on the feed, under its row lock: the one it replaced, or null
 * when the feed is gone.
 */
const setLogo = (feedId: string, sha: string) =>
  store(() =>
    db.transaction(async (tx) => {
      const current = (
        await tx
          .select({ logoSha: feed.logoSha })
          .from(feed)
          .where(eq(feed.id, feedId))
          .for('update')
      ).at(0)
      if (current === undefined) return null
      await tx.update(feed).set({ logoSha: sha }).where(eq(feed.id, feedId))
      await tx.delete(pendingBlob).where(eq(pendingBlob.sha, sha))
      return { previous: current.logoSha }
    }),
  )

/**
 * A short-lived URL on our blob store for each distinct digest, signed once
 * per page however many rows share it: what a page draws a logo or a photo
 * from.
 */
export const feedPictureUrlsProgram = Effect.fn('feeds.pictureUrls')(function* (
  shas: ReadonlyArray<string | null>,
) {
  const out = new Map<string, string>()
  for (const sha of new Set(shas)) {
    if (sha === null) continue
    const url = yield* pictureUrlProgram(sha)
    if (url !== null) out.set(sha, url)
  }
  return out
})
