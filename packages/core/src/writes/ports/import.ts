import { Context, Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { importBatch, importRow } from '@spaces/db/schema'
import { Import, JobPermanent, JobRetryable } from '@spaces/sdk'
import type { StageResult } from '@spaces/sdk'
import { landImportGrid } from '@spaces/sdk/import-grid'
import type { LandedRow } from '@spaces/sdk/import-grid'
import type { BoundIntegration } from './binding'

/**
 * The batch one `file` job run stages into, set by the worker around the
 * run and read only by `ImportLive`. Null outside a run the import wizard
 * started — the port is granted per (integration, job), the batch per run.
 */
export type ImportRunTarget = { readonly batchId: string } | null

export const ImportRun = Context.Reference<ImportRunTarget>(
  'spaces/core/ImportRun',
  { defaultValue: () => null },
)

/** Rows per insert statement: three parameters each, far under pg's 65535. */
const INSERT_CHUNK = 1000

type Staged =
  | { readonly kind: 'staged' }
  | { readonly kind: 'already'; readonly rowCount: number }
  | { readonly kind: 'gone' }
  | { readonly kind: 'closed'; readonly status: string }

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const malformedOf = (rows: ReadonlyArray<LandedRow>) =>
  rows.flatMap((r) =>
    r.reason === null ? [] : [{ ordinal: r.rowNum, reason: r.reason }],
  )

/**
 * ImportLive: a dialect's grid into the waiting `import_batch`, landed by
 * `landImportGrid` — the same answer `ImportTest` gives.
 * - The batch, its header and its rows are one transaction under the
 *   batch's row lock; a batch that already holds rows is answered, not
 *   rewritten, so a retried job stages once.
 * - A malformed row lands with no cells and plans `no-land` alone.
 * - Mapping, preview and commit stay the import wizard's.
 */
export const ImportLive = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
): Layer.Layer<Import> =>
  Layer.succeed(
    Import,
    Import.of({
      stage: (grid) =>
        Effect.gen(function* () {
          const run = yield* ImportRun
          if (run === null)
            return yield* new JobPermanent({
              reason: `${row.capabilityId} called Import.stage outside an import: only a file job the import wizard starts has a batch to stage into`,
            })
          const read = landImportGrid(grid)
          if ('unreadable' in read)
            return yield* new JobPermanent({
              reason: `${row.capabilityId}'s grid is unreadable: ${read.unreadable}`,
            })
          if (read.rows.length === 0)
            return yield* new JobPermanent({
              reason: `${row.capabilityId}'s grid has no row that could be placed`,
            })
          const { batchId } = run
          const staged = yield* Effect.tryPromise({
            try: () =>
              db.transaction(async (tx): Promise<Staged> => {
                const batch = (
                  await tx
                    .select({
                      status: importBatch.status,
                      rowCount: importBatch.rowCount,
                    })
                    .from(importBatch)
                    .where(eq(importBatch.id, batchId))
                    .for('update')
                ).at(0)
                if (!batch) return { kind: 'gone' }
                if (batch.rowCount > 0)
                  return { kind: 'already', rowCount: batch.rowCount }
                if (batch.status !== 'staged')
                  return { kind: 'closed', status: batch.status }
                for (let i = 0; i < read.rows.length; i += INSERT_CHUNK) {
                  await tx.insert(importRow).values(
                    read.rows.slice(i, i + INSERT_CHUNK).map((r) => ({
                      batchId,
                      rowNum: r.rowNum,
                      cells: r.cells === null ? [] : [...r.cells],
                    })),
                  )
                }
                await tx
                  .update(importBatch)
                  .set({
                    header: [...read.columns],
                    headerRow: 0,
                    rowCount: read.rows.length,
                  })
                  .where(eq(importBatch.id, batchId))
                return { kind: 'staged' }
              }),
            catch: (cause) =>
              new JobRetryable({
                reason: `Import.stage failed: ${messageOf(cause)}`,
              }),
          })
          switch (staged.kind) {
            case 'gone':
              return yield* new JobPermanent({
                reason: `import batch ${batchId} no longer exists — it was discarded while it was being read`,
              })
            case 'closed':
              return yield* new JobPermanent({
                reason: `import batch ${batchId} is ${staged.status} and takes no rows`,
              })
            case 'already':
            case 'staged': {
              const result: StageResult = {
                batchId,
                staged:
                  staged.kind === 'already'
                    ? staged.rowCount
                    : read.rows.length,
                malformed: malformedOf(read.rows),
                refused: read.refused,
              }
              return result
            }
          }
        }),
    }),
  )
