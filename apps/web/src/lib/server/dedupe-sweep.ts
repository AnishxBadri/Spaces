import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '../queue'
import { effectFn } from './effect'
import { requireAdmin } from './shared'

/**
 * The human door onto the nightly `entity.dedupe-sweep`, so the owner can run
 * a first pass now. It enqueues exactly the job the schedule enqueues, with
 * the same (empty) payload, so the button and the cron are the same run.
 * - Admin-only: the sweep fills a queue every teammate reads.
 * - A seam, not a lane: nothing here imports the sweep. The web process must
 *   never run the scan inline; that is what the queue exists to prevent.
 */

class EnqueueFailed extends Schema.TaggedError<EnqueueFailed>()(
  'EnqueueFailed',
  { cause: Schema.Defect() },
) {}

const runDedupeSweepProgram = Effect.fn('runDedupeSweep')(
  function* (): Effect.fn.Return<{ jobId: string | null }, EnqueueFailed> {
    // `enqueue` resolves to null rather than throwing when the queue is
    // unreachable, so a Postgres blip is a queued-nothing, not a 500 — and
    // the id is handed back so a caller could say which run it asked for.
    const jobId = yield* Effect.tryPromise({
      try: () => enqueue(QUEUES.dedupeSweep, {}),
      catch: (cause) => new EnqueueFailed({ cause }),
    })
    return { jobId }
  },
)

export const runDedupeSweep = createServerFn({ method: 'POST' }).handler(
  async () => {
    await requireAdmin()
    return effectFn(runDedupeSweepProgram)()
  },
)
