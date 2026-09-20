import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '../queue'
import { effectFn } from './effect'
import { requireAdmin } from './shared'

/**
 * The human door onto `entity.dedupe-sweep` (SPA-81). The job is nightly, at
 * 03:30 — which makes "does it work?" a question nobody can answer before
 * tomorrow, and a first pass on an established workspace something the owner
 * should be able to choose the moment for. This enqueues exactly the job the
 * schedule enqueues, with exactly the payload it sends (none), so the button
 * and the cron are the same run.
 *
 * Admin-only. The sweep writes rows into a queue every teammate reads, and
 * its bounds are the owner's call, so the trigger belongs to the same role
 * that owns the object registry.
 *
 * It is a seam, not a lane: the sweep's own file lives in `worker/jobs/`,
 * and nothing here imports it. A web process that could run the scan inline
 * is exactly what the queue exists to prevent.
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
