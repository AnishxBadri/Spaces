import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { entity } from './entities'
import { objectDef } from './objects'
import type { CoreIdentityKey } from './entities'
import type { attributeType } from './attributes'
import type { Json } from '../json'

/**
 * **Staged import** (SPA-164, import-2; CONTEXT.md phase 15 item 9 — one
 * wizard: upload → map → preview → dry run → commit). A spreadsheet becomes a
 * batch and one row per data row, and nothing reaches the graph: no entity,
 * no document, no edge. The later steps read these rows, write `plan` and
 * `verdict`, and only the commit step stamps `entity_id`.
 *
 * The payload is a **blob, not a document**: `blob_sha` is the content
 * address the bytes were stored under, with no `document` row behind it, so
 * a portfolio spreadsheet is never extracted, chunked or embedded. There is
 * no `blob` table to reference — storage is keyed by the digest itself — so
 * the column is plain text, as `document.blob_sha` is.
 */

/**
 * `records` fills an object from the registry (Companies, People, Deals, any
 * custom object) and needs `target_object_id`; `ledger` writes portfolio
 * events and targets the portfolio, so it has none.
 */
export const importMode = pgEnum('import_mode', ['records', 'ledger'])

export type ImportMode = (typeof importMode.enumValues)[number]

/** Where the batch is in the wizard. Only `staged` is written this slice. */
export const importBatchStatus = pgEnum('import_batch_status', [
  'staged',
  'planned',
  'committed',
  'failed',
])

export type ImportBatchStatus = (typeof importBatchStatus.enumValues)[number]

/**
 * The payload of `import_batch.mapping` (SPA-165, import-3), declared at the
 * column that stores it and re-exported by `@spaces/core/import/mapping`,
 * which owns the behaviour — packages/db imports nothing internal, and the
 * column owns the shape of what it stores (SPA-142).
 *
 * One target per source column, by column index:
 *
 * - `name` — the record's name (exactly one column).
 * - `attribute` — a live attribute of the target object. `dateOrder` is the
 *   column's declared reading of a slashed date, never sniffed.
 * - `identity` — one of the object's identity keys.
 * - `ignore` — the column is not imported.
 * - `new` — an attribute the operator is defining from this column and has
 *   not yet confirmed; confirming creates it and the column becomes an
 *   `attribute` target. `options` are the labels a select will be born with.
 */
export type ImportDateOrder = 'dmy' | 'mdy'

export type ImportAttributeType = (typeof attributeType.enumValues)[number]

export type ColumnTarget =
  | { target: 'name' }
  | { target: 'attribute'; attributeId: string; dateOrder?: ImportDateOrder }
  | { target: 'identity'; key: CoreIdentityKey }
  | { target: 'ignore' }
  | {
      target: 'new'
      name: string
      type: ImportAttributeType
      options?: Array<string>
      dateOrder?: ImportDateOrder
    }

export type Mapping = Array<ColumnTarget>

export const importBatch = pgTable(
  'import_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The storage key of the uploaded bytes — sha256, hashed server-side. */
    blobSha: text('blob_sha').notNull(),
    filename: text('filename').notNull(),
    /** What the server counted; `bigint` for `pending_blob.size_bytes`' reason. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** The sheet whose rows are staged; a CSV's is its filename stem. */
    sheet: text('sheet').notNull(),
    /** Every sheet in the workbook, in tab order — what the tabs draw. */
    sheets: jsonb('sheets').$type<Array<string>>().notNull(),
    /**
     * Index into the sheet's rows of the detected header (`readGrid`'s
     * `headerRow`), null when no row qualified and every row is data.
     */
    headerRow: integer('header_row'),
    /** The header row's cells verbatim, null when `header_row` is. */
    header: jsonb('header').$type<Array<string>>(),
    mode: importMode('mode').notNull(),
    targetObjectId: uuid('target_object_id').references(() => objectDef.id),
    /**
     * Column → target, written by the mapping step on every change; null
     * until the step is entered. A batch with a mapping is on step 2.
     */
    mapping: jsonb('mapping').$type<Mapping>(),
    status: importBatchStatus('status').notNull().default('staged'),
    /** Data rows staged — one `import_row` each. */
    rowCount: integer('row_count').notNull(),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (t) => [
    // "Was this file imported before?" is asked on every upload.
    index('import_batch_blob_sha_idx').on(t.blobSha),
    check('import_batch_row_count_nonnegative', sql`${t.rowCount} >= 0`),
    // Ledger mode targets the portfolio, never an object.
    check(
      'import_batch_ledger_no_target',
      sql`${t.mode} <> 'ledger' or ${t.targetObjectId} is null`,
    ),
    // Records mode may stage before the object is picked, but cannot leave
    // `staged` without one.
    check(
      'import_batch_records_target',
      sql`${t.status} = 'staged' or ${t.mode} = 'ledger' or ${t.targetObjectId} is not null`,
    ),
  ],
)

export const importRow = pgTable(
  'import_row',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatch.id, { onDelete: 'cascade' }),
    /** 1-based ordinal among the sheet's data rows. */
    rowNum: integer('row_num').notNull(),
    /** The row's cells, verbatim strings, padded to the sheet's width. */
    cells: jsonb('cells').$type<Array<string>>().notNull(),
    /** What the preview step decided to do with the row; null until then. */
    plan: jsonb('plan').$type<Json>(),
    verdict: text('verdict'),
    /** The record the commit wrote or matched; null until commit. */
    entityId: uuid('entity_id').references(() => entity.id),
    error: text('error'),
  },
  (t) => [uniqueIndex('import_row_batch_row_unique').on(t.batchId, t.rowNum)],
)
