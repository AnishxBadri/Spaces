import { Effect, Schema } from 'effect'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, jobRun, workerHeartbeat } from '@spaces/db/schema'
import { STALE_AFTER, WORKER_ROLE } from '@spaces/db/heartbeat'
import { ACTION_TARGETS } from '@spaces/sdk'
import { canRead } from '@spaces/core/read-policy'
import { QUEUES } from '@spaces/core/queue/names'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'

/**
 * A record's plugin job state, read from `job_run`: what the status stream
 * opens with and resyncs from, so a reopened page or a dropped stream never
 * depends on a notification that already fired.
 */

export class JobStatusFailed extends Schema.TaggedError<JobStatusFailed>()(
  'JobStatusFailed',
  { cause: Schema.Defect() },
) {}

/** One queue's latest attempt on the record, as the stream's `init` carries it. */
export type JobStatusRow = JobStatusEvent & {
  /** Since the row closed, by the database's clock; null while running. */
  readonly closedAgoMs: number | null
}

/** The error a run reads as when its worker is gone. */
export const WORKER_LOST =
  'worker-lost: the worker stopped before this run finished'

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new JobStatusFailed({ cause }),
  })

/**
 * A `running` row whose worker is gone settles as failed rather than spinning:
 * the worker heartbeat is absent or older than `STALE_AFTER`, or the worker
 * booted after the run started (one worker per database, keyed by role).
 * When pg-boss hands the job out again, that attempt's row arrives as an event.
 */
const workerLost = sql<boolean>`(${jobRun.status} = 'running' and (${workerHeartbeat.beatAt} is null or ${workerHeartbeat.beatAt} < now() - make_interval(secs => ${STALE_AFTER}) or ${workerHeartbeat.bootedAt} > ${jobRun.startedAt}))`

/**
 * The latest attempt on each plugin queue for one record — per watch on a
 * space, whose watches may share one engine's queue.
 */
export const jobStatusSnapshotProgram = Effect.fn('jobStatusSnapshotProgram')(
  function* (
    entityId: string,
  ): Effect.fn.Return<Array<JobStatusRow>, JobStatusFailed> {
    const rows = yield* query(() =>
      db
        .selectDistinctOn([jobRun.queue, jobRun.watchId], {
          jobRunId: jobRun.id,
          queue: jobRun.queue,
          integrationId: jobRun.integrationId,
          entityId: jobRun.entityId,
          watchId: jobRun.watchId,
          status: jobRun.status,
          startedAt: jobRun.startedAt,
          summary: jobRun.summary,
          error: jobRun.error,
          lost: workerLost,
          // finished_at is the worker's clock, now() the database's; clamp the skew.
          // greatest() skips NULL, so a still-open run must stay outside it.
          closedAgoMs: sql<
            number | null
          >`(case when ${jobRun.finishedAt} is null then null else greatest(0, extract(epoch from now() - ${jobRun.finishedAt}) * 1000) end)::float8`,
        })
        .from(jobRun)
        .leftJoin(workerHeartbeat, eq(workerHeartbeat.role, WORKER_ROLE))
        .where(
          and(
            eq(jobRun.entityId, entityId),
            or(
              sql`starts_with(${jobRun.queue}, 'plugin.')`,
              eq(jobRun.queue, QUEUES.enrichmentRun),
            ),
          ),
        )
        .orderBy(jobRun.queue, jobRun.watchId, desc(jobRun.startedAt)),
    )
    return rows.map(({ lost, startedAt, watchId, ...row }): JobStatusRow => ({
      ...row,
      ...(watchId === null ? {} : { watchId }),
      startedAt: startedAt.toISOString(),
      status: lost ? 'failed' : row.status,
      error: lost ? WORKER_LOST : row.error,
    }))
  },
)

/** A space streams its watch runs, which carry its id. */
const RECORD_KINDS: ReadonlySet<string> = new Set([...ACTION_TARGETS, 'space'])

/**
 * Whether `user` may watch this record's jobs: the record page would render
 * it for them — it exists, is a company, person, deal or space, is not
 * merged away, and `canRead` passes as that user, never as an integration.
 */
export const recordReadableProgram = Effect.fn('recordReadableProgram')(
  function* (
    user: { readonly id: string },
    entityId: string,
  ): Effect.fn.Return<boolean, JobStatusFailed> {
    const row = (yield* query(() =>
      db
        .select({ kind: entity.kind, mergedIntoId: entity.mergedIntoId })
        .from(entity)
        .where(eq(entity.id, entityId)),
    )).at(0)
    if (row === undefined || row.mergedIntoId !== null) return false
    // A record carries no visibility of its own, so `canRead` always passes;
    // it is asked so a richer policy binds here too.
    return RECORD_KINDS.has(row.kind) && canRead(user, {})
  },
)
