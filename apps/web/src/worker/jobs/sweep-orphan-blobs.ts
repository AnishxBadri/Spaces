import { Effect, Schema } from 'effect'
import { eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { pendingBlob } from '@spaces/db/schema'
import { storage } from '#/lib/storage'
import { QUEUES } from '@spaces/core/queue/names'
import { blobIsReferenced } from '#/lib/documents/blob-refs'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * blob.sweep-orphans — the other direction of blob GC (SPA-54, CONTEXT.md
 * "Standing debt" → orphan-blob sweep).
 *
 * The only reclaim in the product runs off a document row being deleted. But
 * upload is two calls around a direct-to-storage PUT: `prepareDocumentUpload`
 * hands out a URL, the browser PUTs, and `finalizeDocumentUpload` writes the
 * row. A tab closed in between leaves bytes no row will ever name, and four
 * more entry points — drop-into-note, URL clip, Drive sync, the server
 * intake — each reopen the same window. This job is what closes it.
 *
 * **Why an intent row and not a store listing.** The obvious sweep asks the
 * store what it holds and deletes whatever no document names. It was
 * rejected, and the reasons are the shape of this file:
 *
 *  - it needs `list()` on the `Storage` port, which CONTEXT.md → Storage
 *    freezes at five methods and which the S3 driver landed against verbatim;
 *  - on S3 a `LIST` is a paginated scan of the whole bucket, so the nightly
 *    cost is proportional to everything ever uploaded rather than to the
 *    handful of uploads currently in flight;
 *  - and a prefix walk cannot tell an orphan from an arrival in flight. A key
 *    on disk carries no record of when it was promised, so a listing sweep
 *    either races a live 200MB PUT or leans on the store's mtime, which S3
 *    sets when the PUT *completes*.
 *
 * `pending_blob` knows exactly when the URL was handed out, which is the one
 * fact the decision needs, and it is written by the code that hands it out.
 */

/**
 * How long bytes may sit unnamed before they are assumed abandoned.
 *
 * 24 hours, and generously so: the window it has to clear is a browser PUT,
 * which is minutes at worst even for a 200MB deck on a bad line. What the
 * rest of the day buys is every way a finalize can be *late* rather than
 * absent — a laptop asleep between the PUT and the tab regaining focus, a
 * worker restarted mid-sync, an operator's clock a few minutes off the
 * database's. Deleting bytes that were about to be filed is unrecoverable;
 * keeping them a day longer costs disk.
 *
 * Overridable **through the job's data** and not through an env var: the
 * only caller that wants a different number is a test proving the before/
 * after of the grace period, and a deployment-wide knob for that would be a
 * way to switch the safety off in production by accident.
 */
export const ORPHAN_BLOB_GRACE_MS = 24 * 60 * 60 * 1000

/** Rows one run may reclaim. The rest wait for tomorrow — as `dedupeSweep`. */
export const ORPHAN_BLOB_PER_RUN = 500

/**
 * Nullish-tolerant for the same reason `dedupeSweepData` is: pg-boss stores
 * `data = null` for a schedule registered with no payload, and the nightly
 * schedule is registered exactly that way — a bare `z.object({…})` would fail
 * every run as `invalid-data` before the handler ever ran.
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
   * Rows past grace whose digest a document row *does* name. A birth that
   * failed to clear its own row, which should be none: the count is the
   * alarm.
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
 * The job body, exported so a test drives it with a payload and no pg-boss in
 * sight — the `dedupeSweep` shape, and like it carrying no Layer: its I/O is
 * the same `db` every read uses plus the configured `storage()`, and faking
 * either would assert nothing the sweep is about.
 *
 * **The order is load-bearing.** For each candidate: ask whether a document
 * row names the digest, delete the bytes only if none does, and delete the
 * pending row last. The check is `blobIsReferenced` — the same call
 * `deleteDocumentWithBlobGc` makes, so "still referenced" has one definition
 * in the codebase rather than one per direction.
 *
 * A finalize landing between the check and the delete would cost the bytes of
 * an upload a day old that nobody filed for a day — the grace period is what
 * makes that window theoretical rather than a race worth locking against. The
 * pending row is deleted after the bytes and not before, so a store that
 * throws leaves the row for tomorrow's run instead of stranding the bytes
 * forever.
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
    const referenced = yield* query(() => blobIsReferenced(sha))
    if (referenced) {
      // A document row names these bytes, so they are not ours to take.
      // The row is spent either way — birth should have cleared it.
      kept += 1
    } else {
      yield* query(() => storage().delete(sha))
      reclaimed += 1
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
  // A count, never the digests: a log line per sha would be a list of
  // content addresses in the operator's journal for no reader's benefit,
  // and the rows themselves are gone by the time anyone reads it.
  console.log(
    `[worker] ${QUEUES.sweepOrphanBlobs} examined ${String(result.examined)} · reclaimed ${String(result.reclaimed)}${result.kept > 0 ? ` · kept ${String(result.kept)} already filed` : ''}${result.capped ? ` · capped at ${String(ORPHAN_BLOB_PER_RUN)}` : ''} · ${String(result.ms)}ms`,
  )
  return result
})

/** Promise seam for a direct drive, as `runDedupeSweepJob` is for the sweep. */
export const runSweepOrphanBlobsJob = (
  data: SweepOrphanBlobsData,
): Promise<SweepOrphanBlobsResult> =>
  Effect.runPromise(sweepOrphanBlobsProgram(data))

export const sweepOrphanBlobs: JobDef<SweepOrphanBlobsData> = {
  name: QUEUES.sweepOrphanBlobs,
  schema: sweepOrphanBlobsData,
  // No `refs`: a sweep is about no one row, which is the case `JobRunRefs`
  // documents both of its fields as optional for.
  run: (data) =>
    sweepOrphanBlobsProgram(data).pipe(
      Effect.asVoid,
      // Retryable, always. Every branch above is idempotent — a deleted blob
      // deletes again as a no-op (`rm --force`, and S3's DELETE on a missing
      // key succeeds), and a row already gone matches nothing — so a partial
      // run simply resumes from where it stopped on the next attempt.
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
