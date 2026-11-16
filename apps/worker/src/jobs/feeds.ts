import { Effect } from 'effect'
import type { Layer } from 'effect'
import { z } from 'zod'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { FEED_IMAGE_BATCH } from '@spaces/core/feeds/fetch'
import {
  feedIdsProgram,
  pollFeedProgram,
  pruneFeedItemsProgram,
} from '#web/lib/feeds/poll'
import {
  fetchFeedLogoProgram,
  fetchItemImagesProgram,
} from '#web/lib/feeds/images'
import type { FeedLogoFetched } from '#web/lib/feeds/images'
import type { FeedPolled, FeedStoreFailed } from '#web/lib/feeds/poll'
import { enqueue } from '#web/lib/queue'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'

/**
 * Feeds on the worker: the half-hourly poll that sends one fetch per feed,
 * the fetch itself, the photos of its new headlines on their own queue,
 * each source's logo (on add and weekly), and the daily delete past 90 days.
 * - Zod data, because `JobDef.schema` is still a zod type.
 * - Nullish data on the two scheduled jobs: pg-boss stores `null` for a
 *   schedule with no payload.
 */

const scheduled = z
  .object({})
  .nullish()
  .transform((v) => v ?? {})

/** Never retried: the next tick is the retry. */
export const feedPollRetry: JobRetryPolicy = {
  limit: 0,
  delaySeconds: 0,
  backoff: false,
}

/** The poll's fan-out, through the worker's sender. */
export const feedEnqueue: Layer.Layer<Enqueue> = Enqueue.fromSender({
  enqueue: (queue, data, options) => enqueue(queue, data, options),
})

const storeRetry = (e: FeedStoreFailed) =>
  new JobRetryable({ reason: `feed store: ${e.message}` })

/** One job per feed on `queue`, keyed by the feed. */
const sendPerFeed = Effect.fn('feeds.sendPerFeed')(function* (
  queue: typeof QUEUES.feedFetch | typeof QUEUES.feedLogo,
  noun: string,
) {
  const sender = yield* Enqueue
  const ids = yield* feedIdsProgram().pipe(Effect.mapError(storeRetry))
  let sent = 0
  for (const feedId of ids) {
    const id = yield* sender.enqueue(
      queue,
      { feedId },
      { singletonKey: feedId },
    )
    if (id !== null) sent += 1
  }
  return `${String(ids.length)} feeds, ${String(sent)} ${noun} sent`
})

const sendFetches = () => sendPerFeed(QUEUES.feedFetch, 'fetches')

/**
 * feed.poll: one `feed.fetch` per feed, keyed by the feed, so a fetch still
 * queued from the last tick is not queued twice.
 */
export const feedPoll: JobDef<z.infer<typeof scheduled>, Enqueue> = {
  name: QUEUES.feedPoll,
  schema: scheduled,
  retry: feedPollRetry,
  run: () => sendFetches(),
}

export const feedFetchData = z.object({ feedId: z.uuid() })

/**
 * Within the half hour: a timeout, a 5xx or a 429 tries again a minute
 * later, then two; the tick after that is the next chance.
 */
export const feedFetchRetry: JobRetryPolicy = {
  limit: 2,
  delaySeconds: 60,
  backoff: true,
}

const summaryOf = (polled: FeedPolled): string => {
  switch (polled._tag) {
    case 'Gone':
      return 'feed removed before its fetch'
    case 'NotModified':
      return 'not modified'
    case 'Fetched':
      return `${String(polled.added)} new of ${String(polled.seen)}`
  }
}

/** The new headlines' photos onto `feed.images`, a batch per job. */
const sendImages = Effect.fn('feeds.sendImages')(function* (
  polled: FeedPolled,
) {
  if (polled._tag !== 'Fetched') return
  const sender = yield* Enqueue
  for (let at = 0; at < polled.withImages.length; at += FEED_IMAGE_BATCH)
    yield* sender.enqueue(QUEUES.feedImages, {
      itemIds: polled.withImages.slice(at, at + FEED_IMAGE_BATCH),
    })
})

/**
 * feed.fetch: one feed polled, and the photos of its new headlines sent to
 * their own queue. Its failure is already on the row when the job fails;
 * the job's own outcome only decides whether pg-boss retries.
 */
export const feedFetch: JobDef<z.infer<typeof feedFetchData>, Enqueue> = {
  name: QUEUES.feedFetch,
  schema: feedFetchData,
  retry: feedFetchRetry,
  run: (data) =>
    pollFeedProgram(data.feedId).pipe(
      Effect.tap(sendImages),
      Effect.map(summaryOf),
      Effect.mapError((failed): JobRetryable | JobPermanent =>
        failed._tag === 'FeedStoreFailed'
          ? new JobRetryable({ reason: `feed store: ${failed.message}` })
          : failed.retryable
            ? new JobRetryable({ reason: failed.message })
            : new JobPermanent({ reason: failed.message }),
      ),
    ),
}

/**
 * feed.prune: every headline published more than 90 days ago, deleted, and
 * the photos no other row holds reclaimed.
 */
export const feedPrune: JobDef<z.infer<typeof scheduled>> = {
  name: QUEUES.feedPrune,
  schema: scheduled,
  run: () =>
    pruneFeedItemsProgram().pipe(
      Effect.map(
        ({ deleted, reclaimed }) =>
          `deleted ${String(deleted)}, ${String(reclaimed)} photos reclaimed`,
      ),
      // A delete by cutoff re-runs as a no-op, so every failure is retryable.
      Effect.catchTag('FeedStoreFailed', (failed) =>
        Effect.fail(
          new JobRetryable({ reason: `feed store: ${failed.message}` }),
        ),
      ),
    ),
}

export const feedImagesData = z.object({
  itemIds: z.array(z.uuid()).max(FEED_IMAGE_BATCH),
})

/**
 * Once, a minute later: a photo is a nicety, and a headline that lands
 * without one is the designed outcome when its host is slow.
 */
export const feedImagesRetry: JobRetryPolicy = {
  limit: 1,
  delaySeconds: 60,
  backoff: false,
}

/**
 * feed.images: the photos of a batch of new headlines. A photo the guard
 * refuses, over the cap or not an image is skipped, not a failure; only the
 * store failing retries, and a retry fetches only what is still missing.
 */
export const feedImages: JobDef<z.infer<typeof feedImagesData>> = {
  name: QUEUES.feedImages,
  schema: feedImagesData,
  retry: feedImagesRetry,
  run: (data) =>
    fetchItemImagesProgram(data.itemIds).pipe(
      Effect.map(
        ({ stored, skipped }) =>
          `${String(stored)} photos stored, ${String(skipped)} skipped`,
      ),
      Effect.mapError(storeRetry),
    ),
}

const logoSummaryOf = (fetched: FeedLogoFetched): string => {
  switch (fetched._tag) {
    case 'Gone':
      return 'feed removed before its logo'
    case 'None':
      return `no logo among ${String(fetched.tried)} candidates`
    case 'Stored':
      return fetched.changed ? 'logo stored' : 'logo unchanged'
  }
}

export const feedLogoData = z.object({ feedId: z.uuid() })

/**
 * feed.logo: one source's logo, the feed's own image else the site's icon.
 * Finding none is a success the page answers with the monogram; only the
 * store failing retries.
 */
export const feedLogo: JobDef<z.infer<typeof feedLogoData>> = {
  name: QUEUES.feedLogo,
  schema: feedLogoData,
  retry: feedImagesRetry,
  run: (data) =>
    fetchFeedLogoProgram(data.feedId).pipe(
      Effect.map(logoSummaryOf),
      Effect.mapError(storeRetry),
    ),
}

/** feed.logos: the weekly fan-out, one `feed.logo` per feed. */
export const feedLogos: JobDef<z.infer<typeof scheduled>, Enqueue> = {
  name: QUEUES.feedLogos,
  schema: scheduled,
  retry: feedPollRetry,
  run: () => sendPerFeed(QUEUES.feedLogo, 'logo fetches'),
}
