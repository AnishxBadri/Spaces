import { Effect } from 'effect'
import type { Layer } from 'effect'
import { z } from 'zod'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import {
  feedIdsProgram,
  pollFeedProgram,
  pruneFeedItemsProgram,
} from '#web/lib/feeds/poll'
import type { FeedPolled } from '#web/lib/feeds/poll'
import { enqueue } from '#web/lib/queue'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'

/**
 * Feeds on the worker: the half-hourly poll that sends one fetch per feed,
 * the fetch itself, and the daily delete past 90 days.
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

const sendFetches = Effect.fn('feedPoll')(function* () {
  const queue = yield* Enqueue
  const ids = yield* feedIdsProgram().pipe(
    Effect.mapError(
      (e) => new JobRetryable({ reason: `feed store: ${e.message}` }),
    ),
  )
  let sent = 0
  for (const feedId of ids) {
    const id = yield* queue.enqueue(
      QUEUES.feedFetch,
      { feedId },
      { singletonKey: feedId },
    )
    if (id !== null) sent += 1
  }
  return `${String(ids.length)} feeds, ${String(sent)} fetches sent`
})

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

/**
 * feed.fetch: one feed polled. Its failure is already on the row when the
 * job fails; the job's own outcome only decides whether pg-boss retries.
 */
export const feedFetch: JobDef<z.infer<typeof feedFetchData>> = {
  name: QUEUES.feedFetch,
  schema: feedFetchData,
  retry: feedFetchRetry,
  run: (data) =>
    pollFeedProgram(data.feedId).pipe(
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

/** feed.prune: every headline published more than 90 days ago, deleted. */
export const feedPrune: JobDef<z.infer<typeof scheduled>> = {
  name: QUEUES.feedPrune,
  schema: scheduled,
  run: () =>
    pruneFeedItemsProgram().pipe(
      Effect.map(({ deleted }) => `deleted ${String(deleted)}`),
      // A delete by cutoff re-runs as a no-op, so every failure is retryable.
      Effect.catchTag('FeedStoreFailed', (failed) =>
        Effect.fail(
          new JobRetryable({ reason: `feed store: ${failed.message}` }),
        ),
      ),
    ),
}
