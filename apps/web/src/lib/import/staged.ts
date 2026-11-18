import { Effect, Schema } from 'effect'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { importBatch } from '@spaces/db/schema'

/**
 * The imports the reader staged and has not committed: Today's `import`
 * rows. Only `staged` counts — a planned batch is on its preview, and a
 * mapping change returns it here. A commit or a discard takes it off.
 * Outside the server-fn barrel so tests can call it without a request.
 */

export class StagedImportsReadFailed extends Schema.TaggedError<StagedImportsReadFailed>()(
  'StagedImportsReadFailed',
  { cause: Schema.Defect() },
) {}

/** One staged batch as Today's row draws it. */
export type StagedImport = {
  batchId: string
  filename: string
  /** Data rows waiting in the batch. */
  rowCount: number
  /** When it was staged, ISO. */
  stagedAt: string
}

export const stagedImportsProgram = Effect.fn('stagedImportsProgram')(
  function* (
    userId: string,
  ): Effect.fn.Return<StagedImport[], StagedImportsReadFailed> {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            batchId: importBatch.id,
            filename: importBatch.filename,
            rowCount: importBatch.rowCount,
            createdAt: importBatch.createdAt,
          })
          .from(importBatch)
          .where(
            and(
              eq(importBatch.status, 'staged'),
              eq(importBatch.createdBy, userId),
            ),
          )
          .orderBy(asc(importBatch.createdAt)),
      catch: (cause) => new StagedImportsReadFailed({ cause }),
    })
    return rows.map((r) => ({
      batchId: r.batchId,
      filename: r.filename,
      rowCount: r.rowCount,
      stagedAt: r.createdAt.toISOString(),
    }))
  },
)
