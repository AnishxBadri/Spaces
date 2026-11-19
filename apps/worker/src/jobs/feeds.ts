import { Effect, Schema } from 'effect'
import type { Layer } from 'effect'
import { emptyObject, scheduled, uuid } from '../job-data'
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
  photoRetryIdsProgram,
} from '#web/lib/feeds/images'
import type { FeedLogoFetched } from '#web/lib/feeds/images'
import type { FeedPolled, FeedStoreFailed } from '#web/lib/feeds/poll'
import { enqueue } from '#web/lib/queue'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'

/**
 * Feeds on the worker: the half-hourly poll that sends one fetch per feed
 * and the failed photos due another try, the fetch itself, the photos of its new headlines on their own queue,
 * each source's logo (on add and weekly), and the daily delete past 90 days.
 * - Nullish data on the two scheduled jobs: pg-boss stores `null` for a
 *   schedule with no payload.
 */

const scheduledData = scheduled(emptyObject, {})

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

/** Headline ids onto `feed.images`, a batch per job. */
const sendImageBatches = Effect.fn('feeds.sendImageBatches')(function* (
  itemIds: ReadonlyArray<string>,
) {
  const sender = yield* Enqueue
  for (let at = 0; at < itemIds.length; at += FEED_IMAGE_BATCH)
    yield* sender.enqueue(QUEUES.feedImages, {
      itemIds: itemIds.slice(at, at + FEED_IMAGE_BATCH),
    })
})

/** The failed photos due another try, bounded per poll. */
const sendPhotoRetries = Effect.fn('feeds.sendPhotoRetries')(function* () {
  const ids = yield* photoRetryIdsProgram().pipe(Effect.mapError(storeRetry))
  yield* sendImageBatches(ids)
  return ids.length
})

/**
 * feed.poll: one `feed.fetch` per feed, keyed by the feed, so a fetch still
 * queued from the last tick is not queued twice; and the failed photos due
 * another try sent back to `feed.images`, which fetches only what is still
 * due when it runs, so a batch sent twice fetches once.
 */
export const feedPoll: JobDef<typeof scheduledData.Type, Enqueue> = {
  name: QUEUES.feedPoll,
  schema: scheduledData,
  retry: feedPollRetry,
  run: () =>
    Effect.gen(function* () {
      const fetches = yield* sendFetches()
      const retries = yield* sendPhotoRetries()
      return `${fetches}, ${String(retries)} photo retries sent`
    }),
}

export const feedFetchData = Schema.Struct({ feedId: uuid })

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
  yield* sendImageBatches(polled.withImages)
})

/**
 * feed.fetch: one feed polled, and the photos of its new headlines sent to
 * their own queue. Its failure is already on the row when the job fails;
 * the job's own outcome only decides whether pg-boss retries.
 */
export const feedFetch: JobDef<typeof feedFetchData.Type, Enqueue> = {
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
export const feedPrune: JobDef<typeof scheduledData.Type> = {
  name: QUEUES.feedPrune,
  schema: scheduledData,
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

export const feedImagesData = Schema.Struct({
  itemIds: Schema.Array(uuid).check(Schema.isMaxLength(FEED_IMAGE_BATCH)),
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
 * feed.images: the photos of a batch of headlines, new or due another try.
 * A photo the guard refuses, over the cap or not an image is skipped and
 * counted on its headline for the poll's later try, not a job failure; only
 * the store failing retries the job, and that retry fetches only what is
 * still missing.
 */
export const feedImages: JobDef<typeof feedImagesData.Type> = {
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

export const feedLogoData = Schema.Struct({ feedId: uuid })

/**
 * feed.logo: one source's logo, the feed's own image else the site's icon.
 * Finding none is a success the page answers with the monogram; only the
 * store failing retries.
 */
export const feedLogo: JobDef<typeof feedLogoData.Type> = {
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
export const feedLogos: JobDef<typeof scheduledData.Type, Enqueue> = {
  name: QUEUES.feedLogos,
  schema: scheduledData,
  retry: feedPollRetry,
  run: () => sendPerFeed(QUEUES.feedLogo, 'logo fetches'),
}
