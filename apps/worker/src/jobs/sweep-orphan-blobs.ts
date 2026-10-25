import { Effect, Schema } from 'effect'
import { eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { pendingBlob } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { reclaimBlobIfOrphaned } from '#web/lib/documents/blob-refs'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * blob.sweep-orphans: reclaims bytes uploaded under a URL that no document
 * row ever came to name (a tab closed between prepare and finalize, and the
 * same window in every other arrival lane).
 *
 * Driven by `pending_blob` intent rows, not a store listing:
 * - a listing needs `list()`, which the `Storage` port deliberately lacks;
 * - an S3 `LIST` scans the whole bucket rather than the uploads in flight;
 * - a listing cannot tell an orphan from a live PUT (S3 mtime is set when the
 *   PUT completes). `pending_blob` records when the URL was handed out.
 */

/**
 * How long bytes may sit unnamed before they are assumed abandoned.
 * - 24 hours, generously: a PUT takes minutes, but a finalize can be late
 *   (laptop asleep, worker restarted, clock skew), and deleting bytes about
 *   to be filed is unrecoverable.
 * - Overridable through the job's data, never an env var: a deployment-wide
 *   knob could switch the safety off in production by accident.
 */
export const ORPHAN_BLOB_GRACE_MS = 24 * 60 * 60 * 1000

/** Rows one run may reclaim. The rest wait for the next run. */
export const ORPHAN_BLOB_PER_RUN = 500

/**
 * Nullish-tolerant: pg-boss stores `data = null` for the payload-less nightly
 * schedule, which a bare `z.object({…})` would fail as `invalid-data`.
 */
export const sweepOrphanBlobsData = z
  .object({ graceMs: z.number().int().nonnegative().optional() })
  .nullish()
  .transform((v) => v ?? {})

export type SweepOrphanBlobsData = z.infer<typeof sweepOrphanBlobsData>

export interface SweepOrphanBlobsResult {
  /** Pending rows past the grace period this run looked at. */
  readonly examined: number
  /** Blobs whose bytes were deleted — the orphans. */
  readonly reclaimed: number
  /**
   * Rows past grace whose digest a document row does name: a birth that
   * failed to clear its row. Should be zero; the count is the alarm.
   */
  readonly kept: number
  /** True when more rows were past grace than `perRun` would take. */
  readonly capped: boolean
  readonly ms: number
}

export class SweepOrphanBlobsFailed extends Schema.TaggedError<SweepOrphanBlobsFailed>()(
  'SweepOrphanBlobsFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SweepOrphanBlobsFailed({ cause }),
  })

/**
 * The job body, exported so a test drives it without pg-boss.
 *
 * The order is load-bearing. Per candidate: ask whether a document row names
 * the digest (`blobIsReferenced`, the same check the delete path uses), delete
 * the bytes only if none does, delete the pending row last, so a store that
 * throws leaves the row for the next run instead of stranding the bytes. The
 * grace period makes a finalize racing the check theoretical.
 */
export const sweepOrphanBlobsProgram = Effect.fn('sweepOrphanBlobs')(function* (
  data: SweepOrphanBlobsData,
): Effect.fn.Return<SweepOrphanBlobsResult, SweepOrphanBlobsFailed> {
  const started = Date.now()
  const graceMs = data.graceMs ?? ORPHAN_BLOB_GRACE_MS
  const cutoff = new Date(started - graceMs)

  // One more than the cap, so `capped` is read off the same snapshot the
  // run acted on rather than from a second count.
  const candidates = yield* query(() =>
    db
      .select({ sha: pendingBlob.sha })
      .from(pendingBlob)
      .where(lt(pendingBlob.preparedAt, cutoff))
      .orderBy(pendingBlob.preparedAt)
      .limit(ORPHAN_BLOB_PER_RUN + 1),
  )
  const capped = candidates.length > ORPHAN_BLOB_PER_RUN
  const due = candidates.slice(0, ORPHAN_BLOB_PER_RUN)

  let reclaimed = 0
  let kept = 0
  for (const { sha } of due) {
    // `reclaimBlobIfOrphaned` asks `blobIsReferenced` and, only on a no,
    // drops the bytes and what was derived from them.
    if (yield* query(() => reclaimBlobIfOrphaned(sha))) reclaimed += 1
    else {
      // A document row names these bytes, so they stay. The pending row is
      // spent either way.
      kept += 1
    }
    yield* query(() => db.delete(pendingBlob).where(eq(pendingBlob.sha, sha)))
  }

  const result: SweepOrphanBlobsResult = {
    examined: due.length,
    reclaimed,
    kept,
    capped,
    ms: Date.now() - started,
  }
  // Counts, never the digests: a list of content addresses in the log helps
  // no reader.
  console.log(
    `[worker] ${QUEUES.sweepOrphanBlobs} examined ${String(result.examined)} · reclaimed ${String(result.reclaimed)}${result.kept > 0 ? ` · kept ${String(result.kept)} already filed` : ''}${result.capped ? ` · capped at ${String(ORPHAN_BLOB_PER_RUN)}` : ''} · ${String(result.ms)}ms`,
  )
  return result
})

/** Promise seam for driving the sweep directly. */
export const runSweepOrphanBlobsJob = (
  data: SweepOrphanBlobsData,
): Promise<SweepOrphanBlobsResult> =>
  Effect.runPromise(sweepOrphanBlobsProgram(data))

export const sweepOrphanBlobs: JobDef<SweepOrphanBlobsData> = {
  name: QUEUES.sweepOrphanBlobs,
  schema: sweepOrphanBlobsData,
  // No `refs`: a sweep is about no one row.
  run: (data) =>
    sweepOrphanBlobsProgram(data).pipe(
      Effect.asVoid,
      // Always retryable: every step is idempotent (deleting a missing blob
      // succeeds on disk and S3, a gone row matches nothing), so a partial
      // run resumes on the next attempt.
      Effect.catchTag(
        'SweepOrphanBlobsFailed',
        (err) =>
          new JobRetryable({
            reason: `orphan-blob sweep failed: ${messageOf(err.cause)}`,
          }),
      ),
    ),
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
