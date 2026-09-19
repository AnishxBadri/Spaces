import { Cause, Context, Duration, Effect, Exit, Option, Schema } from 'effect'
import type { Layer } from 'effect'
import type { JobWithMetadata, PgBoss } from 'pg-boss'
import type { z } from 'zod'

/**
 * The one wrapper every job goes through (spec-plugin-sdk §11; CONTEXT.md
 * "Workers and jobs"). Parse job.data against the JobDef's schema, provide
 * the job's Layer plus a JobContext, run the Effect, and resolve each job in
 * the batch explicitly.
 *
 * Two pg-boss facts shape this. A batch handler that rejects fails the whole
 * batch, so `runJob`'s own promise must never reject — hostability contract 2
 * says an uncaught throw past the wrapper is a container death. And pg-boss
 * settles the batch itself once the handler resolves, but `complete()` only
 * touches jobs still in the `active` state, so jobs this wrapper has already
 * resolved are left alone.
 */

// ---------------------------------------------------------------------------
// Typed outcomes
// ---------------------------------------------------------------------------

/**
 * The work may succeed on a later attempt: a network blip, a blob the store
 * has not replicated yet, a lock held elsewhere. Retry handling belongs to
 * the queue's retryLimit/retryBackoff — the wrapper never counts attempts.
 */
export class JobRetryable extends Schema.TaggedError<JobRetryable>()(
  'JobRetryable',
  { reason: Schema.String },
) {}

/**
 * A throttle, not a failure. The job is completed and re-sent with
 * `startAfter`, so waiting on someone else's rate limit never burns the
 * retry budget that real failures need.
 */
export class JobRateLimited extends Schema.TaggedError<JobRateLimited>()(
  'JobRateLimited',
  { reason: Schema.String, retryAfterMs: Schema.Number },
) {}

/** Running it again would produce the same result. Fail now, no retry. */
export class JobPermanent extends Schema.TaggedError<JobPermanent>()(
  'JobPermanent',
  { reason: Schema.String },
) {}

export type JobFailure = JobRetryable | JobRateLimited | JobPermanent

export type JobOutcomeKind =
  | 'completed'
  | 'retryable'
  | 'rate-limited'
  | 'permanent'
  | 'invalid-data'
  | 'defect'

/** What the wrapper stores on the pg-boss job row as its output. */
export interface JobOutcome {
  readonly kind: JobOutcomeKind
  readonly queue: string
  readonly attempt: number
  readonly reason: string
}

// ---------------------------------------------------------------------------
// JobContext — provided by the wrapper, never constructed by a tenant
// ---------------------------------------------------------------------------

/**
 * What a tenant is allowed to know about its own invocation. `attempt` and
 * `isFinalAttempt` are the ones that matter: they let a handler tell a retry
 * that is still coming from the last one, which is how extract-document
 * avoids writing a terminal status on an attempt that will run again.
 */
export class JobContext extends Context.Service<
  JobContext,
  {
    readonly queue: string
    readonly jobId: string
    readonly attempt: number
    readonly isFinalAttempt: boolean
  }
>()('spaces/worker/JobContext') {}

// ---------------------------------------------------------------------------
// JobDef
// ---------------------------------------------------------------------------

/** Queue-level retry policy, applied to the queue row — not by the wrapper. */
export interface JobRetryPolicy {
  readonly limit: number
  readonly delaySeconds: number
  readonly backoff: boolean
}

export interface JobDef<TData, TServices = never> {
  readonly name: string
  readonly schema: z.ZodType<TData>
  readonly run: (
    data: TData,
  ) => Effect.Effect<void, JobFailure, TServices | JobContext>
  readonly retry?: JobRetryPolicy
  readonly timeout?: Duration.Input
  readonly concurrency?: number
}

// ---------------------------------------------------------------------------
// JobHost — the seam the wrapper settles through
// ---------------------------------------------------------------------------

/**
 * Everything `runJob` needs from pg-boss, so the wrapper's own tests drive it
 * against a fake with no Postgres in sight.
 */
export interface JobHost {
  readonly complete: (
    queue: string,
    jobId: string,
    output: JobOutcome,
  ) => Promise<void>
  /** Fails the job, honouring the queue's remaining retries. */
  readonly fail: (
    queue: string,
    jobId: string,
    output: JobOutcome,
  ) => Promise<void>
  /** Fails the job with no further attempt, whatever retries remain. */
  readonly failTerminal: (
    queue: string,
    jobId: string,
    output: JobOutcome,
  ) => Promise<void>
  readonly send: (
    queue: string,
    data: object,
    startAfter: Date,
  ) => Promise<void>
}

/**
 * pg-boss 12 has no terminal-fail primitive: `boss.fail()` always re-inserts
 * the job in `retry` state while `retry_count < retry_limit` (the
 * `forceTerminal` branch of its failJobs CTE is reachable only through the
 * `perJobResults` handler contract). So a permanent failure is `fail()` —
 * which records the error output — followed by `cancel()`, which moves a job
 * that is still pre-completion to `cancelled` and preserves that output. On
 * a job whose retries were already exhausted, `fail()` lands it in `failed`
 * and the `cancel()` is a no-op.
 */
export function pgBossHost(boss: PgBoss): JobHost {
  return {
    complete: async (queue, jobId, output) => {
      await boss.complete(queue, jobId, { ...output })
    },
    fail: async (queue, jobId, output) => {
      await boss.fail(queue, jobId, { ...output })
    },
    failTerminal: async (queue, jobId, output) => {
      await boss.fail(queue, jobId, { ...output })
      await boss.cancel(queue, jobId)
    },
    send: async (queue, data, startAfter) => {
      await boss.send(queue, data, { startAfter })
    },
  }
}

// ---------------------------------------------------------------------------
// runJob
// ---------------------------------------------------------------------------

export interface RunJobOptions<TServices> {
  readonly host: JobHost
  readonly layer: Layer.Layer<TServices>
}

/** The pg-boss batch handler for a JobDef. Its promise never rejects. */
export function runJob<TData, TServices>(
  def: JobDef<TData, TServices>,
  options: RunJobOptions<TServices>,
): (jobs: Array<JobWithMetadata<object>>) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) await settle(def, options, job)
  }
}

async function settle<TData, TServices>(
  def: JobDef<TData, TServices>,
  options: RunJobOptions<TServices>,
  job: JobWithMetadata<object>,
): Promise<void> {
  const queue = def.name
  // retry_count is incremented when pg-boss hands a retried job back out, so
  // the first run sees 0 and the last one sees retry_limit.
  const attempt = job.retryCount + 1
  const isFinalAttempt = job.retryCount >= job.retryLimit
  const outcome = (kind: JobOutcomeKind, reason: string): JobOutcome => ({
    kind,
    queue,
    attempt,
    reason,
  })

  try {
    const parsed = def.schema.safeParse(job.data)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      console.error(
        `[worker] ${queue} ${job.id}: job data failed the schema — ${issues}`,
      )
      await options.host.failTerminal(
        queue,
        job.id,
        outcome('invalid-data', issues),
      )
      return
    }

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        withTimeout(
          def,
          Effect.provideService(
            def.run(parsed.data),
            JobContext,
            JobContext.of({ queue, jobId: job.id, attempt, isFinalAttempt }),
          ),
        ),
        options.layer,
      ),
    )

    if (Exit.isSuccess(exit)) {
      await options.host.complete(queue, job.id, outcome('completed', 'ok'))
      return
    }

    const failure = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failure)) {
      await resolveFailure(options.host, queue, job, failure.value, outcome)
      return
    }

    // No typed failure in the cause: either the fiber was interrupted (worker
    // shutdown — the job deserves another run) or the handler threw something
    // the type said it would not. The second is the case contract 2 is about.
    if (Cause.hasInterrupts(exit.cause)) {
      const reason = 'handler was interrupted'
      console.warn(
        `[worker] ${queue} ${job.id}: ${reason} (attempt ${attempt})`,
      )
      await options.host.fail(queue, job.id, outcome('retryable', reason))
      return
    }

    const defect = Cause.squash(exit.cause)
    const reason =
      defect instanceof Error ? defect.message : Cause.pretty(exit.cause)
    console.error(
      `[worker] ${queue} ${job.id}: defect on attempt ${attempt} — ${reason}`,
      defect,
    )
    await options.host.failTerminal(queue, job.id, outcome('defect', reason))
  } catch (err) {
    // The host itself failed (Postgres went away mid-settlement). Nothing left
    // to do but say so: pg-boss's own expiry will reclaim the job, and
    // rejecting here would take the rest of the batch with it.
    console.error(
      `[worker] ${queue} ${job.id}: could not resolve the job — leaving it to pg-boss`,
      err,
    )
  }
}

function withTimeout<TData, TServices>(
  def: JobDef<TData, TServices>,
  effect: Effect.Effect<void, JobFailure, TServices>,
): Effect.Effect<void, JobFailure, TServices> {
  const duration = def.timeout
  if (duration === undefined) return effect
  return Effect.timeoutOrElse(effect, {
    duration,
    orElse: () =>
      Effect.fail(
        new JobRetryable({
          reason: `handler exceeded its ${Duration.format(Duration.fromInputUnsafe(duration))} timeout and was interrupted`,
        }),
      ),
  })
}

async function resolveFailure(
  host: JobHost,
  queue: string,
  job: JobWithMetadata<object>,
  failure: JobFailure,
  outcome: (kind: JobOutcomeKind, reason: string) => JobOutcome,
): Promise<void> {
  switch (failure._tag) {
    case 'JobRetryable': {
      console.warn(`[worker] ${queue} ${job.id}: ${failure.reason} (retryable)`)
      await host.fail(queue, job.id, outcome('retryable', failure.reason))
      return
    }
    case 'JobRateLimited': {
      const startAfter = new Date(Date.now() + failure.retryAfterMs)
      console.warn(
        `[worker] ${queue} ${job.id}: ${failure.reason} — re-sent for ${startAfter.toISOString()}`,
      )
      await host.send(queue, job.data, startAfter)
      await host.complete(
        queue,
        job.id,
        outcome('rate-limited', failure.reason),
      )
      return
    }
    case 'JobPermanent': {
      console.error(
        `[worker] ${queue} ${job.id}: ${failure.reason} (permanent)`,
      )
      await host.failTerminal(
        queue,
        job.id,
        outcome('permanent', failure.reason),
      )
      return
    }
  }
}
