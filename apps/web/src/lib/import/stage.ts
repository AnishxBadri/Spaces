import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import { and, asc, count, desc, eq, isNotNull, ne, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  importBatch,
  importRow,
  objectDef,
  pendingBlob,
} from '@spaces/db/schema'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { GridRefused, readGrid } from '@spaces/core/import/read'
import { reclaimBlobIfOrphaned } from '#/lib/documents/blob-refs'
import { putBlobProgram } from '#/lib/documents/intake'
import { storage } from '#/lib/storage'
import type { Grid, Sheet } from '@spaces/core/import/read'
import type { ImportBatchStatus, ImportMode } from '@spaces/db/schema'
import type { Mapping } from '@spaces/core/import/mapping'

/**
 * **Staged import** (SPA-164, import-2) — the wizard's first step, folded
 * together with its define step: a spreadsheet arrives, is read by
 * `readGrid`, stored as a blob, and becomes one `import_batch` plus one
 * `import_row` per data row. Nothing reaches the graph. The bytes go through
 * `putBlobProgram`, the blob half of the server lane, and stop there: no
 * `document` row, so no extraction, no chunk, no embedding — a portfolio
 * spreadsheet never becomes AI context.
 *
 * It lives in `lib/import/` and not in `lib/server/` for birth's reason: a
 * plain export from a module the server-fns barrel re-exports ships to the
 * browser (CLAUDE.md → Traps, SPA-155), and the tests call these programs
 * without a request. `lib/server/imports.ts` reaches it by dynamic import.
 */

/** Rows the wizard draws under the header before the mapping step. */
export const PREVIEW_ROWS = 20

/** Rows per insert statement: three parameters each, far under pg's 65535. */
const INSERT_CHUNK = 1000

/** The file or the choice is refused; `reason` is shown to the user verbatim. */
export class ImportRefused extends Schema.TaggedError<ImportRefused>()(
  'ImportRefused',
  { reason: Schema.String },
) {}

export class ImportNotFound extends Schema.TaggedError<ImportNotFound>()(
  'ImportNotFound',
  {},
) {}

/** The read, the store or a query broke. */
export class ImportFailed extends Schema.TaggedError<ImportFailed>()(
  'ImportFailed',
  { cause: Schema.Defect() },
) {}

export type ImportFailure = ImportRefused | ImportNotFound | ImportFailed

/**
 * The sentence a caller shows. A tagged error carries no `message`, so the
 * refusal's own words travel in `reason` — `readGrid`'s refusals name the
 * file, and they reach the user unchanged.
 */
export function importMessage(failure: unknown): string {
  if (failure instanceof ImportRefused) return failure.reason
  if (failure instanceof ImportNotFound) return 'This import no longer exists'
  return 'Could not stage this file'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ImportFailed({ cause }) })

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** The rows after the header — every row when no header was detected. */
export function dataRowsOf(sheet: Sheet): Array<Array<string>> {
  return sheet.rows.slice(sheet.headerRow === null ? 0 : sheet.headerRow + 1)
}

/** The first sheet with data; a workbook's cover tab is not the import. */
function pickSheet(grid: Grid): Sheet | null {
  return (
    grid.sheets.find((s) => dataRowsOf(s).length > 0) ??
    grid.sheets.at(0) ??
    null
  )
}

const readGridOrRefuse = (bytes: Uint8Array, filename: string) =>
  Effect.try({
    try: () => readGrid(bytes, filename),
    catch: (cause) =>
      cause instanceof GridRefused
        ? new ImportRefused({ reason: cause.message })
        : new ImportFailed({ cause }),
  })

/** The sheet columns a batch carries, as written on the row. */
function sheetColumns(sheet: Sheet) {
  return {
    sheet: sheet.name,
    headerRow: sheet.headerRow,
    header: sheet.headerRow === null ? null : sheet.rows[sheet.headerRow],
    rowCount: dataRowsOf(sheet).length,
  }
}

async function insertRows(
  tx: Tx,
  batchId: string,
  rows: Array<Array<string>>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await tx.insert(importRow).values(
      rows.slice(i, i + INSERT_CHUNK).map((cells, j) => ({
        batchId,
        rowNum: i + j + 1,
        cells,
      })),
    )
  }
}

// ---------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------

/**
 * Ledger mode targets the portfolio and carries no object; records mode may
 * stage before the object is picked, but a picked one must be a live row of
 * the registry.
 */
const checkTarget = Effect.fn('checkImportTarget')(function* (
  mode: ImportMode,
  targetObjectId: string | null,
): Effect.fn.Return<void, ImportRefused | ImportFailed> {
  if (targetObjectId === null) return
  if (mode === 'ledger')
    return yield* new ImportRefused({
      reason: 'A ledger import targets the portfolio, not an object',
    })
  const row = yield* query(() =>
    db
      .select({ archived: objectDef.archived })
      .from(objectDef)
      .where(eq(objectDef.id, targetObjectId))
      .then((rows) => rows.at(0)),
  )
  if (!row || row.archived)
    return yield* new ImportRefused({
      reason: 'That object is archived or no longer exists',
    })
})

// ---------------------------------------------------------------------------
// Earlier imports of the same bytes
// ---------------------------------------------------------------------------

export type PreviousImport = {
  id: string
  filename: string
  status: ImportBatchStatus
  rowCount: number
  /** Rows whose commit wrote or matched a record. */
  written: number
  createdAt: string
  committedAt: string | null
}

/** The latest other batch staged from this digest, or null. */
export const previousImportOf = Effect.fn('previousImportOf')(function* (
  sha: string,
  excludeBatchId: string | null,
): Effect.fn.Return<PreviousImport | null, ImportFailed> {
  const row = yield* query(() =>
    db
      .select({
        id: importBatch.id,
        filename: importBatch.filename,
        status: importBatch.status,
        rowCount: importBatch.rowCount,
        createdAt: importBatch.createdAt,
        committedAt: importBatch.committedAt,
      })
      .from(importBatch)
      .where(
        excludeBatchId === null
          ? eq(importBatch.blobSha, sha)
          : and(
              eq(importBatch.blobSha, sha),
              ne(importBatch.id, excludeBatchId),
            ),
      )
      .orderBy(desc(importBatch.createdAt))
      .limit(1)
      .then((rows) => rows.at(0)),
  )
  if (!row) return null
  const written = yield* query(() =>
    db
      .select({ value: count() })
      .from(importRow)
      .where(and(eq(importRow.batchId, row.id), isNotNull(importRow.entityId)))
      .then((rows) => rows.at(0)?.value ?? 0),
  )
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    rowCount: row.rowCount,
    written,
    createdAt: row.createdAt.toISOString(),
    committedAt: row.committedAt?.toISOString() ?? null,
  }
})

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export type StageImportInput = {
  filename: string
  bytes: Uint8Array
  mime: string | null
  mode: ImportMode
  targetObjectId: string | null
  /** Stage even when these bytes were imported before. */
  allowDuplicate: boolean
  userId: string
}

export type StageImportResult =
  | { kind: 'staged'; batchId: string }
  | { kind: 'duplicate'; previous: PreviousImport }

/**
 * Size → read → target → blob → (earlier import?) → batch + rows.
 *
 * Every refusal comes before the store: an over-limit file, a file
 * `readGrid` refuses (legacy .xls, over `MAX_IMPORT_ROWS`), an empty sheet or
 * a bad target stores nothing. Bytes already imported answer with the
 * earlier batch instead of a second one unless the caller says to stage
 * again; the blob is content-addressed, so that check costs no second copy.
 *
 * The batch, its rows and the clearing of the blob's `pending_blob` intent
 * row are one transaction — a crash before it leaves an intent row the
 * orphan sweep reclaims, never bytes nobody named.
 */
export const stageImportProgram = Effect.fn('stageImportProgram')(function* (
  input: StageImportInput,
): Effect.fn.Return<StageImportResult, ImportRefused | ImportFailed> {
  const { filename, bytes } = input
  if (bytes.byteLength === 0)
    return yield* new ImportRefused({ reason: `${filename} is empty` })
  if (bytes.byteLength > MAX_UPLOAD_BYTES)
    return yield* new ImportRefused({
      reason: `${filename} is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
    })

  const grid = yield* readGridOrRefuse(bytes, filename)
  const sheet = pickSheet(grid)
  if (sheet === null || dataRowsOf(sheet).length === 0)
    return yield* new ImportRefused({
      reason: `${filename} has no rows to import`,
    })

  yield* checkTarget(input.mode, input.targetObjectId)

  const blob = yield* putBlobProgram({
    stream: Readable.from([Buffer.from(bytes)]),
    mime: input.mime,
    preparedBy: input.userId,
  }).pipe(
    Effect.catchTags({
      DocumentTooLarge: () =>
        new ImportRefused({
          reason: `${filename} is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
        }),
      DocumentIntakeFailed: (e) => new ImportFailed({ cause: e.cause }),
    }),
  )

  if (!input.allowDuplicate) {
    const previous = yield* previousImportOf(blob.sha, null)
    if (previous) return { kind: 'duplicate', previous }
  }

  const rows = dataRowsOf(sheet)
  const batchId = yield* query(() =>
    db.transaction(async (tx) => {
      const inserted = (
        await tx
          .insert(importBatch)
          .values({
            blobSha: blob.sha,
            filename,
            sizeBytes: blob.sizeBytes,
            sheets: grid.sheets.map((s) => s.name),
            ...sheetColumns(sheet),
            mode: input.mode,
            targetObjectId: input.targetObjectId,
            createdBy: input.userId,
          })
          .returning({ id: importBatch.id })
      ).at(0)
      if (!inserted) throw new Error('import_batch insert returned no row')
      await insertRows(tx, inserted.id, rows)
      // The batch names the bytes now; the intent row has done its job.
      await tx.delete(pendingBlob).where(eq(pendingBlob.sha, blob.sha))
      return inserted.id
    }),
  )
  return { kind: 'staged', batchId }
})

// ---------------------------------------------------------------------------
// A staged batch: read, define, switch sheet, discard
// ---------------------------------------------------------------------------

export const stagedBatch = Effect.fn('stagedBatch')(function* (
  batchId: string,
): Effect.fn.Return<
  typeof importBatch.$inferSelect,
  ImportRefused | ImportNotFound | ImportFailed
> {
  const batch = yield* query(() =>
    db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
      .then((rows) => rows.at(0)),
  )
  if (!batch) return yield* new ImportNotFound()
  if (batch.status !== 'staged')
    return yield* new ImportRefused({
      reason: `This import is ${batch.status} and can no longer change`,
    })
  return batch
})

/**
 * A batch the wizard may still change: staged, or planned (SPA-167) — a
 * planned batch's mapping can still move, and the change throws its plan
 * away (`mapping.ts`'s `writeMapping`). Committed and failed batches are
 * the record of what an import did.
 */
export const editableBatch = Effect.fn('editableBatch')(function* (
  batchId: string,
): Effect.fn.Return<
  typeof importBatch.$inferSelect,
  ImportRefused | ImportNotFound | ImportFailed
> {
  const batch = yield* query(() =>
    db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
      .then((rows) => rows.at(0)),
  )
  if (!batch) return yield* new ImportNotFound()
  if (batch.status !== 'staged' && batch.status !== 'planned')
    return yield* new ImportRefused({
      reason: `This import is ${batch.status} and can no longer change`,
    })
  if (batch.status === 'planned' && (yield* commitStarted(batch.id)))
    return yield* new ImportRefused({ reason: COMMITTING })
  return batch
})

/** A planned batch's refusal once its commit has written a row (SPA-169). */
export const COMMITTING =
  'This import is being committed and can no longer change'

/**
 * Whether a commit has reached any row of the batch — written it or failed
 * it (SPA-169). A plan the commit is replaying must not move under it, so a
 * mapping change or a decision is refused from then on.
 */
export const commitStarted = (batchId: string) =>
  query(() =>
    db
      .select({ rowNum: importRow.rowNum })
      .from(importRow)
      .where(
        and(
          eq(importRow.batchId, batchId),
          or(isNotNull(importRow.entityId), isNotNull(importRow.error)),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
  )

/**
 * Throw a batch's plan away and return it to `staged` — every row's `plan`
 * and `verdict` cleared in the transaction that changed what they were
 * computed from, so a stale verdict has nowhere to be read from.
 */
export async function clearPlan(tx: Tx, batchId: string): Promise<void> {
  await tx
    .update(importRow)
    .set({ plan: null, verdict: null })
    .where(eq(importRow.batchId, batchId))
  await tx
    .update(importBatch)
    .set({ status: 'staged' })
    .where(eq(importBatch.id, batchId))
}

export type ImportBatchView = {
  id: string
  filename: string
  sizeBytes: number
  sheet: string
  sheets: Array<string>
  headerRow: number | null
  header: Array<string> | null
  mode: ImportMode
  targetObjectId: string | null
  /** Column → target; null until the mapping step is entered (SPA-165). */
  mapping: Mapping | null
  status: ImportBatchStatus
  rowCount: number
  /** The sheet's width — every row is padded to it. */
  columnCount: number
  createdAt: string
  /** The first `PREVIEW_ROWS` data rows, in sheet order. */
  preview: Array<{ rowNum: number; cells: Array<string> }>
  /** The latest other batch staged from the same bytes. */
  previous: PreviousImport | null
}

export const loadImportBatchProgram = Effect.fn('loadImportBatchProgram')(
  function* (
    batchId: string,
  ): Effect.fn.Return<ImportBatchView, ImportNotFound | ImportFailed> {
    const batch = yield* query(() =>
      db
        .select()
        .from(importBatch)
        .where(eq(importBatch.id, batchId))
        .then((rows) => rows.at(0)),
    )
    if (!batch) return yield* new ImportNotFound()
    const preview = yield* query(() =>
      db
        .select({ rowNum: importRow.rowNum, cells: importRow.cells })
        .from(importRow)
        .where(eq(importRow.batchId, batchId))
        .orderBy(asc(importRow.rowNum))
        .limit(PREVIEW_ROWS),
    )
    const previous = yield* previousImportOf(batch.blobSha, batch.id)
    return {
      id: batch.id,
      filename: batch.filename,
      sizeBytes: batch.sizeBytes,
      sheet: batch.sheet,
      sheets: batch.sheets,
      headerRow: batch.headerRow,
      header: batch.header,
      mode: batch.mode,
      targetObjectId: batch.targetObjectId,
      mapping: batch.mapping,
      status: batch.status,
      rowCount: batch.rowCount,
      columnCount: batch.header?.length ?? preview.at(0)?.cells.length ?? 0,
      createdAt: batch.createdAt.toISOString(),
      preview,
      previous,
    }
  },
)

/** The define step: records into an object, or the portfolio ledger. */
export const defineImportBatchProgram = Effect.fn('defineImportBatchProgram')(
  function* (input: {
    batchId: string
    mode: ImportMode
    targetObjectId: string | null
  }): Effect.fn.Return<void, ImportFailure> {
    const batch = yield* stagedBatch(input.batchId)
    const targetObjectId = input.mode === 'ledger' ? null : input.targetObjectId
    yield* checkTarget(input.mode, targetObjectId)
    // A mapping is onto one object's registry; another target starts over.
    const same =
      batch.mode === input.mode && batch.targetObjectId === targetObjectId
    yield* query(() =>
      db
        .update(importBatch)
        .set({
          mode: input.mode,
          targetObjectId,
          ...(same ? {} : { mapping: null }),
        })
        .where(eq(importBatch.id, input.batchId)),
    )
  },
)

/**
 * Another tab of the workbook: the rows are re-read from the stored blob and
 * restaged in place, so the batch always holds the sheet it names.
 */
export const selectImportSheetProgram = Effect.fn('selectImportSheetProgram')(
  function* (input: {
    batchId: string
    sheet: string
  }): Effect.fn.Return<void, ImportFailure> {
    const batch = yield* stagedBatch(input.batchId)
    if (batch.sheet === input.sheet) return
    const bytes = yield* query(() => storage().getBytes(batch.blobSha))
    const grid = yield* readGridOrRefuse(bytes, batch.filename)
    const sheet = grid.sheets.find((s) => s.name === input.sheet)
    if (!sheet)
      return yield* new ImportRefused({
        reason: `${batch.filename} has no sheet named "${input.sheet}"`,
      })
    yield* query(() =>
      db.transaction(async (tx) => {
        await tx.delete(importRow).where(eq(importRow.batchId, batch.id))
        await insertRows(tx, batch.id, dataRowsOf(sheet))
        // Another sheet is other columns: its mapping starts over.
        await tx
          .update(importBatch)
          .set({ ...sheetColumns(sheet), mapping: null })
          .where(eq(importBatch.id, batch.id))
      }),
    )
  },
)

/**
 * Throw a staged or planned batch away. Never a committed one: that batch
 * is the record of what an import wrote. The bytes go too when nothing else names
 * them — `reclaimBlobIfOrphaned` asks documents and batches alike.
 */
export const discardImportBatchProgram = Effect.fn('discardImportBatchProgram')(
  function* (batchId: string): Effect.fn.Return<void, ImportFailure> {
    const batch = yield* editableBatch(batchId)
    yield* query(() =>
      db.delete(importBatch).where(eq(importBatch.id, batchId)),
    )
    yield* query(() => reclaimBlobIfOrphaned(batch.blobSha))
  },
)
