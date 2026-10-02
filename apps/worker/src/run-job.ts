import { Cause, Context, Duration, Effect, Exit, Option } from 'effect'
import type { Layer } from 'effect'
import { and, count, eq, gt, ne, notLike, or, isNull, sql } from 'drizzle-orm'
import type { JobWithMetadata, PgBoss } from 'pg-boss'
import type { z } from 'zod'
import { db } from '@spaces/db'
import { integration, jobRun } from '@spaces/db/schema'
import { JobPermanent, JobRateLimited, JobRetryable } from '@spaces/sdk'
import type { JobRunStatus } from '@spaces/db/schema/jobs'

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
 *
 * It is also the only writer of `job_run` (SPA-106). Every attempt of every
 * queue leaves a row here and nowhere else — extraction, every plugin job the
 * SDK registers, the storage list job, the ingest job — because the wrapper
 * is the only code that sees the two cases a self-instrumenting handler
 * cannot: a defect, and job data that never parsed.
 */

// ---------------------------------------------------------------------------
// Typed outcomes
// ---------------------------------------------------------------------------

/**
 * The three outcomes are the SDK's classes (sdk-11, checkpoint review of
 * PR #4), not a second set sharing their tags: a plugin job's failure and a
 * core job's are the same class, so `runJob` treats both identically.
 * `JobRetryable` — may succeed on a later attempt; retry handling belongs to
 * the queue's retryLimit/retryBackoff, the wrapper never counts attempts.
 * `JobRateLimited` — a throttle, not a failure: the job is completed and
 * re-sent with `startAfter`, so waiting on someone else's rate limit never
 * burns the retry budget. `JobPermanent` — running it again would produce
 * the same result; fail now, no retry.
 */
export { JobPermanent, JobRateLimited, JobRetryable }

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

/**
 * Which rows an invocation is about, for the ledger. Declared, not written: a
 * JobDef says where in its own data the ids live, and `runJob` is what puts
 * them on the `job_run` row. Both are optional because both are genuinely
 * absent half the time — a core job has no integration, a sweep has no entity.
 */
export interface JobRunRefs {
  readonly entityId?: string | null
  readonly integrationId?: string | null
}

/**
 * What a successful attempt may say about itself: one line the wrapper writes
 * to `job_run.summary` (SPA-56's mail poll returns its message counts). A
 * handler with nothing to say returns `void`, and the column stays null.
 */
export type JobSummary = string

/** The transaction a `JobClose` writes in. */
export type JobTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * A success that also writes in the transaction closing its `job_run` row —
 * a schedule job's cursor. `close` runs only for a completed attempt; if it
 * throws, the row still closes, tagged `close-failed:`, and nothing it wrote
 * commits.
 */
export interface JobClose {
  readonly summary: JobSummary | null
  readonly close: (tx: JobTx) => Promise<void>
}

/** What a successful attempt hands back to the wrapper. */
export type JobResult = JobSummary | JobClose | void

export interface JobDef<TData, TServices = never> {
  readonly name: string
  readonly schema: z.ZodType<TData>
  readonly run: (
    data: TData,
  ) => Effect.Effect<JobResult, JobFailure, TServices | JobContext>
  readonly retry?: JobRetryPolicy
  readonly timeout?: Duration.Input
  readonly concurrency?: number
  /** Pure: read ids out of the parsed data, touch nothing. */
  readonly refs?: (data: TData) => JobRunRefs
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
  /**
   * Re-sends a job for later. `singletonKey` carries the original's key, so
   * a keyed job on an `exclusive` queue comes back still holding it (SPA-136).
   */
  readonly send: (
    queue: string,
    data: object,
    startAfter: Date,
    options?: { singletonKey: string },
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
    send: async (queue, data, startAfter, options) => {
      await boss.send(queue, data, { startAfter, ...options })
    },
  }
}

// ---------------------------------------------------------------------------
// job_run — the attempt ledger, written here and nowhere else
// ---------------------------------------------------------------------------

export interface JobRunStart {
  readonly queue: string
  readonly attempt: number
  readonly entityId: string | null
  readonly integrationId: string | null
  readonly startedAt: Date
}

export interface JobRunEnd {
  readonly status: JobRunStatus
  readonly finishedAt: Date
  readonly durationMs: number
  readonly error: string | null
  /** The handler's own line on success; null otherwise. */
  readonly summary: string | null
}

/**
 * The ledger seam, the same bargain `JobHost` makes with pg-boss: the wrapper
 * owns the statements, the seam is what lets its own tests run with no
 * Postgres in sight. The Postgres implementation below is the default and the
 * only one that ships, and it is deliberately not exported — the `insert into
 * job_run` in this file is the only one in the repo, which
 * `job-run-one-writer.test.ts` asserts by scanning the source.
 */
export interface JobRunLedger {
  /** Opens the row in `running`; null means the ledger is unavailable. */
  readonly begin: (row: JobRunStart) => Promise<string | null>
  /**
   * Closes the row. `close` and `charge`, when given, commit with it or not
   * at all. Resolves true when this charge tripped the breaker.
   */
  readonly end: (
    id: string,
    row: JobRunEnd,
    close: JobClose['close'] | null,
    charge: BreakerCharge | null,
  ) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// The plugin breaker — charged in the transaction that closes the row
// ---------------------------------------------------------------------------

/** What a failed attempt on a plugin's queues is charged to. */
export interface BreakerCharge {
  readonly integrationId: string
  /** The queue-name prefix failures are counted over: `plugin.<id>.`. */
  readonly group: string
}

/**
 * A plugin queue's breaker, handed to `runJob` by the plugin host.
 * - `onTrip` runs once, after the tripping row commits. It must not wait on
 *   the queue it is called from: `offWork` waits out the very job calling it.
 */
export interface JobBreaker extends BreakerCharge {
  readonly onTrip: () => void
}

export const BREAKER_FAILURES = 5
const BREAKER_WINDOW_SECONDS = 60 * 60
export const BREAKER_REASON = `${BREAKER_FAILURES} failures in an hour`

/**
 * Charges one failed attempt: `error_count + 1` and `last_error`, then trips
 * the integration to `disabled` (leaving `enabled` alone) on the fifth.
 * - The count is failures on `group`'s queues in the trailing hour since the
 *   group's last success: five in a row, and a success resets the streak.
 * - `error_count` must have reached five too: a reset zeroes it, so the
 *   failures that tripped the breaker never trip it again.
 * - A throttle (`rate-limited:`) is not a failure and is never counted.
 * - The first update takes the integration's row lock, so two attempts of
 *   one plugin closing at once count one after the other.
 * - A tripped row keeps its reason: later charges only add to the count.
 */
async function chargeBreaker(
  tx: JobTx,
  charge: BreakerCharge,
  error: string,
): Promise<boolean> {
  const charged = (
    await tx
      .update(integration)
      .set({
        errorCount: sql`${integration.errorCount} + 1`,
        lastError: sql`case when ${integration.status} = 'disabled' then ${integration.lastError} else ${error.slice(0, 500)} end`,
      })
      .where(eq(integration.id, charge.integrationId))
      .returning({
        status: integration.status,
        enabled: integration.enabled,
        errorCount: integration.errorCount,
      })
  ).at(0)
  if (charged === undefined || charged.status === 'disabled') return false
  if (!charged.enabled || charged.errorCount < BREAKER_FAILURES) return false

  const inGroup = sql`starts_with(${jobRun.queue}, ${charge.group})`
  const lastSuccess = tx
    .select({ at: sql`max(${jobRun.finishedAt})` })
    .from(jobRun)
    .where(and(inGroup, eq(jobRun.status, 'succeeded')))
  const failures =
    (
      await tx
        .select({ n: count() })
        .from(jobRun)
        .where(
          and(
            inGroup,
            eq(jobRun.status, 'failed'),
            or(isNull(jobRun.error), notLike(jobRun.error, 'rate-limited:%')),
            gt(
              jobRun.finishedAt,
              sql`now() - make_interval(secs => ${BREAKER_WINDOW_SECONDS})`,
            ),
            gt(
              jobRun.finishedAt,
              sql`coalesce((${lastSuccess}), '-infinity'::timestamptz)`,
            ),
          ),
        )
    ).at(0)?.n ?? 0
  if (failures < BREAKER_FAILURES) return false

  const tripped = await tx
    .update(integration)
    .set({ status: 'disabled', lastError: BREAKER_REASON })
    .where(
      and(
        eq(integration.id, charge.integrationId),
        ne(integration.status, 'disabled'),
      ),
    )
    .returning({ id: integration.id })
  return tripped.length > 0
}

/** Only a failure the plugin owns is charged: never a throttle or a lost host. */
const chargeable = (settled: JobOutcome | null): boolean =>
  settled !== null &&
  settled.kind !== 'completed' &&
  settled.kind !== 'rate-limited'

/**
 * The wrapper's typed outcome → the ledger's status. Explicit rather than
 * derived, because three of these are judgement calls:
 *
 *  - `retryable` is `failed`. The attempt failed; that pg-boss will hand the
 *    job out again is the *next* attempt's row, not this one's.
 *  - `invalid-data` is `failed` and not a category of its own: from the
 *    ledger's side a job whose data never parsed is an attempt that did no
 *    work, and the `invalid-data:` tag in `error` is what tells them apart.
 *  - `rate-limited` is `failed` too, tagged `rate-limited:`. The work did not
 *    happen, so calling it `succeeded` would inflate every success count on
 *    the Integrations page. It is not `skipped`: that word is reserved for
 *    sdk-16's cache hits and cap refusals, and nothing in this slice writes
 *    it. What makes a throttle different — it is re-sent rather than retried,
 *    so it never burns the retry budget — lives in pg-boss, not here.
 */
const LEDGER_STATUS: Record<JobOutcomeKind, JobRunStatus> = {
  completed: 'succeeded',
  retryable: 'failed',
  'rate-limited': 'failed',
  permanent: 'failed',
  'invalid-data': 'failed',
  defect: 'failed',
}

const postgresLedger: JobRunLedger = {
  begin: async (row) =>
    (
      await db
        .insert(jobRun)
        .values({
          queue: row.queue,
          attempt: row.attempt,
          entityId: row.entityId,
          integrationId: row.integrationId,
          startedAt: row.startedAt,
          status: 'running',
        })
        .returning({ id: jobRun.id })
    ).at(0)?.id ?? null,
  end: async (id, row, close, charge) => {
    if (close === null && charge === null) {
      await db.update(jobRun).set(row).where(eq(jobRun.id, id))
      return false
    }
    return db.transaction(async (tx) => {
      await tx.update(jobRun).set(row).where(eq(jobRun.id, id))
      if (close !== null) await close(tx)
      return charge === null
        ? false
        : chargeBreaker(tx, charge, row.error ?? row.status)
    })
  },
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The ledger is bookkeeping, never a reason a job fails: a Postgres that
 * cannot take the row must not take the extraction down with it. Every call
 * into it is swallowed and logged, and a run whose `begin` failed simply has
 * no row to close.
 */
async function beginRun(
  ledger: JobRunLedger,
  row: JobRunStart,
): Promise<string | null> {
  try {
    return await ledger.begin(row)
  } catch (err) {
    console.error(
      `[worker] ${row.queue}: could not open a job_run row — ${messageOf(err)}`,
    )
    return null
  }
}

async function endRun(
  ledger: JobRunLedger,
  runId: string | null,
  startedAt: Date,
  settled: JobOutcome | null,
  hostError: unknown,
  summary: string | null,
  close: JobClose['close'] | null,
  breaker: JobBreaker | null,
): Promise<void> {
  // Only a completed attempt closes with its write.
  const commit = settled?.kind === 'completed' ? close : null
  const charge: BreakerCharge | null =
    breaker !== null && chargeable(settled)
      ? { integrationId: breaker.integrationId, group: breaker.group }
      : null
  if (runId === null) {
    if (commit !== null) await closeWithoutRow(commit)
    return
  }
  const finishedAt = new Date()
  const row: JobRunEnd = {
    // No settlement means the host itself failed below; the attempt did
    // happen, and leaving the row in `running` would make it look like a
    // worker that died.
    status: settled === null ? 'failed' : LEDGER_STATUS[settled.kind],
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    error: ledgerError(settled, hostError),
    summary: settled?.kind === 'completed' ? summary : null,
  }
  let tripped = false
  try {
    tripped = await ledger.end(runId, row, commit, charge)
  } catch (err) {
    console.error(
      `[worker] could not close job_run ${runId} — ${messageOf(err)}`,
    )
    if (commit === null && charge === null) return
    // The close's or the charge's write failed and took the row's update
    // with it: close the row without it, so it does not sit in `running`.
    try {
      await ledger.end(
        runId,
        commit === null
          ? row
          : {
              ...row,
              error: `close-failed: ${messageOf(err)}`.slice(0, 1000),
            },
        null,
        null,
      )
    } catch (again) {
      console.error(
        `[worker] could not close job_run ${runId} — ${messageOf(again)}`,
      )
    }
  }
  if (!tripped || breaker === null) return
  try {
    breaker.onTrip()
  } catch (err) {
    console.error(
      `[worker] ${breaker.group}: the breaker tripped and its handler threw — ${messageOf(err)}`,
    )
  }
}

/** A completed attempt whose ledger row never opened still commits its write. */
async function closeWithoutRow(close: JobClose['close']): Promise<void> {
  try {
    await db.transaction(close)
  } catch (err) {
    console.error(`[worker] a job's closing write failed — ${messageOf(err)}`)
  }
}

const isJobClose = (result: JobResult): result is JobClose =>
  typeof result === 'object'

/**
 * The wrapper's typed tag, then its reason. This is not the operator-facing
 * text a tenant writes on its own row — `document.extraction_error` keeps
 * that, and the two are not redundant: the tag is a per-attempt
 * classification that is uniform across every queue and lives on a ledger
 * that will be pruned, while the document's message is the current state of
 * one document and outlives every run of it. A reader grouping failures by
 * kind reads this column; a reader asking "what is wrong with this file"
 * reads that one.
 */
function ledgerError(
  settled: JobOutcome | null,
  hostError: unknown,
): string | null {
  if (settled === null)
    return `host-unavailable: ${messageOf(hostError)}`.slice(0, 1000)
  if (settled.kind === 'completed') return null
  return `${settled.kind}: ${settled.reason}`.slice(0, 1000)
}

/**
 * Wraps the host so the wrapper knows how the attempt was actually settled,
 * without threading a return value through every branch below. The note is
 * taken *after* the delegate resolves, so a host that throws leaves no
 * settlement and the row says `host-unavailable` rather than claiming an
 * outcome pg-boss was never told about. `send` is not a settlement — a
 * rate-limited job is re-sent and then completed, and it is the `complete`
 * that records it.
 */
function recordSettlement(
  host: JobHost,
  note: (o: JobOutcome) => void,
): JobHost {
  return {
    complete: async (queue, jobId, output) => {
      await host.complete(queue, jobId, output)
      note(output)
    },
    fail: async (queue, jobId, output) => {
      await host.fail(queue, jobId, output)
      note(output)
    },
    failTerminal: async (queue, jobId, output) => {
      await host.failTerminal(queue, jobId, output)
      note(output)
    },
    send: (queue, data, startAfter, options) =>
      options === undefined
        ? host.send(queue, data, startAfter)
        : host.send(queue, data, startAfter, options),
  }
}

// ---------------------------------------------------------------------------
// runJob
// ---------------------------------------------------------------------------

export interface RunJobOptions<TServices> {
  readonly host: JobHost
  readonly layer: Layer.Layer<TServices>
  /** Defaults to the Postgres ledger; tests hand it a recorder instead. */
  readonly ledger?: JobRunLedger
  /** A plugin queue's breaker; a core queue has none. */
  readonly breaker?: JobBreaker
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

  // One row per attempt, opened before the work and closed in the `finally`
  // below, so a handler that returns through any of the eight branches — or
  // through none of them — still leaves the ledger a finished row.
  const startedAt = new Date()
  const parsed = def.schema.safeParse(job.data)
  const refs = parsed.success ? refsOf(def, parsed.data) : {}
  const ledger = options.ledger ?? postgresLedger
  const runId = await beginRun(ledger, {
    queue,
    attempt,
    startedAt,
    entityId: refs.entityId ?? null,
    integrationId: refs.integrationId ?? null,
  })
  // A holder, not a `let`: a variable only ever assigned inside a callback
  // narrows to its initial `null` at every later read.
  const recorded: { outcome: JobOutcome | null } = { outcome: null }
  const host = recordSettlement(options.host, (o) => {
    recorded.outcome = o
  })
  let hostError: unknown = null
  let summary: string | null = null
  let close: JobClose['close'] | null = null

  try {
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      console.error(
        `[worker] ${queue} ${job.id}: job data failed the schema — ${issues}`,
      )
      await host.failTerminal(queue, job.id, outcome('invalid-data', issues))
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
      const result = exit.value
      if (isJobClose(result)) {
        summary = result.summary
        close = result.close
      } else {
        summary = typeof result === 'string' ? result : null
      }
      await host.complete(queue, job.id, outcome('completed', summary ?? 'ok'))
      return
    }

    const failure = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failure)) {
      await resolveFailure(host, queue, job, failure.value, outcome)
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
      await host.fail(queue, job.id, outcome('retryable', reason))
      return
    }

    const defect = Cause.squash(exit.cause)
    const reason =
      defect instanceof Error ? defect.message : Cause.pretty(exit.cause)
    console.error(
      `[worker] ${queue} ${job.id}: defect on attempt ${attempt} — ${reason}`,
      defect,
    )
    await host.failTerminal(queue, job.id, outcome('defect', reason))
  } catch (err) {
    // The host itself failed (Postgres went away mid-settlement). Nothing left
    // to do but say so: pg-boss's own expiry will reclaim the job, and
    // rejecting here would take the rest of the batch with it.
    hostError = err
    console.error(
      `[worker] ${queue} ${job.id}: could not resolve the job — leaving it to pg-boss`,
      err,
    )
  } finally {
    await endRun(
      ledger,
      runId,
      startedAt,
      recorded.outcome,
      hostError,
      summary,
      close,
      options.breaker ?? null,
    )
  }
}

/** `def.refs` is a tenant's function; a throw in it must not cost a job. */
function refsOf<TData, TServices>(
  def: JobDef<TData, TServices>,
  data: TData,
): JobRunRefs {
  const read = def.refs
  if (read === undefined) return {}
  try {
    return read(data)
  } catch (err) {
    console.error(
      `[worker] ${def.name}: refs() threw — the job_run row loses its ids: ${messageOf(err)}`,
    )
    return {}
  }
}

function withTimeout<TData, TServices>(
  def: JobDef<TData, TServices>,
  effect: Effect.Effect<JobResult, JobFailure, TServices>,
): Effect.Effect<JobResult, JobFailure, TServices> {
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
      const key = job.singletonKey
      if (key === null) {
        await host.send(queue, job.data, startAfter)
        await host.complete(
          queue,
          job.id,
          outcome('rate-limited', failure.reason),
        )
        return
      }
      // A keyed job re-sends with its key (SPA-136's backfill), and on an
      // `exclusive` queue this job holds that key until it leaves `active` —
      // a send first would be refused as a duplicate and the job would
      // vanish. So it is settled first and re-sent after; the cost is that a
      // failed send now loses the job rather than leaving it to expire, which
      // for a keyed job is a press of its button away.
      await host.complete(
        queue,
        job.id,
        outcome('rate-limited', failure.reason),
      )
      await host.send(queue, job.data, startAfter, { singletonKey: key })
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
