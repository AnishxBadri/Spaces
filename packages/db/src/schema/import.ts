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
import type { distributionKind, instrument, markBasis } from './portfolio'

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

/**
 * Where the batch is in the wizard. `planned` once every row carries its
 * plan (SPA-167); a mapping change returns it to `staged`.
 */
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
 *   `createMissing` (SPA-168, `record_reference` columns only, default off)
 *   plans a record of the referenced object for a cell that names none.
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
  | {
      target: 'attribute'
      attributeId: string
      dateOrder?: ImportDateOrder
      createMissing?: true
    }
  | { target: 'identity'; key: CoreIdentityKey }
  | { target: 'ignore' }
  | {
      target: 'new'
      name: string
      type: ImportAttributeType
      options?: Array<string>
      dateOrder?: ImportDateOrder
    }
  | LedgerTarget

export type Mapping = Array<ColumnTarget>

// ---------------------------------------------------------------------------
// Ledger mode (SPA-170, import-8)
// ---------------------------------------------------------------------------

export type LedgerInstrument = (typeof instrument.enumValues)[number]
export type LedgerMarkBasis = (typeof markBasis.enumValues)[number]
export type LedgerDistributionKind =
  (typeof distributionKind.enumValues)[number]

/**
 * The event fields a ledger column maps onto — not attributes: the company
 * (matched through the reference matcher), our cheque, the round it was
 * part of, a current mark, and proceeds.
 */
export type LedgerField =
  | 'company'
  | 'date'
  | 'amount'
  | 'currency'
  | 'instrument'
  | 'cap'
  | 'discount'
  | 'shares'
  | 'vehicle'
  | 'roundKind'
  | 'roundDate'
  | 'raised'
  | 'preMoney'
  | 'postMoney'
  | 'pricePerShare'
  | 'sharesOutstanding'
  | 'markValue'
  | 'markDate'
  | 'markBasis'
  | 'distributionAmount'
  | 'distributionDate'
  | 'distributionKind'

/**
 * An instrument cell's resolution: one of the enum, or `per_row` — each row
 * carrying the value is decided on its own (`instrumentByRow`).
 */
export type LedgerInstrumentResolution = LedgerInstrument | 'per_row'

/**
 * A ledger column's target. The decisions the plan needs ride on the column
 * they are about, as `dateOrder` does in records mode, so planning the batch
 * twice reads the same stored answer and a column moved elsewhere starts its
 * decisions over (its values are other values):
 *
 * - `dateOrder` — on every date field.
 * - `createMissing` — on `company`: a company the matcher does not find is
 *   planned as a create.
 * - `instrumentMap` — on `instrument`: source value (its `instrumentKey`) →
 *   resolution. `instrumentByRow` — row number → instrument, for the values
 *   resolved `per_row`.
 * - `currency` — on `amount`: the currency of a row that names none.
 * - `marksAsOf` — on `markValue`: the date of a mark whose row has none.
 */
export type LedgerTarget = {
  target: 'ledger'
  field: LedgerField
  dateOrder?: ImportDateOrder
  createMissing?: true
  instrumentMap?: Record<string, LedgerInstrumentResolution>
  instrumentByRow?: Record<string, LedgerInstrument>
  currency?: string
  marksAsOf?: string
}

/**
 * The payload of `import_row.plan` (SPA-167, import-5): what the preview step
 * decided to do with one row, stored so the commit replays it rather than
 * recomputing an answer that could disagree with the report. Declared at the
 * column and re-exported by `@spaces/core/import/plan`, which owns the rules.
 *
 * - `attach` — an identity key matched a live record (`entityId`,
 *   `matchedOn`); the row's values land on it.
 * - `create` — no match; `creator` births the record.
 * - `collide` — the row shares an identity key with another row of this file
 *   under a different name, and waits on a `decision` (`collidesWith` names
 *   the other rows). Its `entityId` / `matchedOn` are kept, so a decision
 *   restores the row to what the resolver said.
 * - `merged` — the row folds into row `mergedInto`: same key and same name,
 *   or the losing side of a decided collision. Counted once, on that row.
 * - `skip` — a decided collision's `skip-both`.
 * - `no-land` — the row cannot be written as it stands; `errors` say why.
 */
export type ImportVerdict =
  'attach' | 'create' | 'collide' | 'merged' | 'skip' | 'no-land'

/**
 * The three doors a new record goes through, by target object: people and
 * companies through `resolveEntity`, a deal through its birth path
 * (`createDeal`), a custom record through `createRecordProgram`.
 */
export type ImportCreator =
  'resolveEntity' | 'dealBirth' | 'createRecordProgram'

export type CollisionDecision = 'keep-first' | 'keep-second' | 'skip-both'

/** One cell that did not read: its column index, the cell, and why. */
export type ImportCellIssue = { column: number; raw: string; reason: string }

/** A coerced cell — the write shape `setValues` takes (core's `CoercedValue`). */
export type ImportCellValue = string | number | boolean | Array<string>

/**
 * A reference cell the plan settled (SPA-168): the record it found, the
 * member it found, or the record a secondary create will make — `key` names
 * that create across the batch (one per referenced object and name), and the
 * create itself rides on one row's `alsoCreates`.
 */
export type ImportReference =
  | {
      to: 'record'
      column: number
      attributeId: string
      entityId: string
      name: string
    }
  | {
      to: 'member'
      column: number
      attributeId: string
      userId: string
      name: string
    }
  | {
      to: 'create'
      column: number
      attributeId: string
      key: string
      name: string
      objectId: string
      /** The secondary create, as it will be planned. */
      creator: ImportCreator
      createName: string | null
      identity: Partial<Record<CoreIdentityKey, string>>
    }

/**
 * A record of the referenced object this row's reference creates before the
 * row lands — carried by exactly one row per `key`, so two rows naming one
 * missing company plan one create.
 */
export type ImportAlsoCreate = {
  key: string
  column: number
  attributeId: string
  objectId: string
  plan: RowPlan
}

export type RecordRowPlan = {
  verdict: ImportVerdict
  creator: ImportCreator
  /** The name cell, trimmed; null when blank. */
  name: string | null
  /** Attach: the record matched, and on which key. */
  entityId?: string
  matchedOn?: { kind: CoreIdentityKey; value: string }
  /** Attribute id → coerced value, blanks omitted. */
  patch: Record<string, ImportCellValue>
  /** Identity key → normalised value, as the resolver compares it. */
  identity: Partial<Record<CoreIdentityKey, string>>
  /** What stops the row landing; empty unless `no-land`. */
  errors: Array<ImportCellIssue>
  /** Cells left out of a row that still lands. */
  skippedCells: Array<ImportCellIssue>
  mergedInto?: number
  collidesWith?: Array<number>
  decision?: CollisionDecision
  /** Reference cells that resolved, or plan a create (SPA-168). */
  references?: Array<ImportReference>
  /** Records of referenced objects this row creates first (SPA-168). */
  alsoCreates?: Array<ImportAlsoCreate>
}

/** A planned financing round (`round` columns); money as numbers until the write. */
export type LedgerRoundEvent = {
  date: string
  kind: string
  raised: number | null
  currency: string | null
  preMoney: number | null
  postMoney: number | null
  pricePerShare: number | null
  sharesOutstanding: number | null
}

/** Our cheque (`investment` columns). `roundRow` names the row whose round it joins. */
export type LedgerInvestmentEvent = {
  date: string
  amount: number
  currency: string
  instrument: LedgerInstrument
  shares: number | null
  cap: number | null
  discount: number | null
  vehicle: string | null
  roundRow: number | null
}

export type LedgerMarkEvent = {
  date: string
  fairValue: number
  currency: string
  basis: LedgerMarkBasis
}

export type LedgerDistributionEvent = {
  date: string
  amount: number
  currency: string
  kind: LedgerDistributionKind
}

/** One row's dated events — never a balance. */
export type LedgerEvents = {
  round?: LedgerRoundEvent
  investment: LedgerInvestmentEvent
  mark?: LedgerMarkEvent
  distribution?: LedgerDistributionEvent
}

/** A decision the operator has not made that stops a row. */
export type LedgerNeed = 'instrument' | 'marksAsOf' | 'currency' | 'dateOrder'

export type LedgerPlan = {
  /** The company across the batch: `entity:<id>` or a create's key. */
  company: string | null
  /** This row births the company's holding — one row per company, at most. */
  birthsHolding: boolean
  /** Null when the row does not land. */
  events: LedgerEvents | null
  /** Decisions whose absence stops the row. */
  needs: Array<LedgerNeed>
}

/**
 * A ledger row's plan (SPA-170): the records plan's frame — the verdict says
 * what happened to the company (`attach` found, `create` planned, `no-land`
 * errors), `references` names it, `alsoCreates` carries its create — plus
 * the row's dated events.
 */
export type LedgerRowPlan = RecordRowPlan & {
  kind: 'ledger'
  ledger: LedgerPlan
}

export type RowPlan = RecordRowPlan | LedgerRowPlan

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
    plan: jsonb('plan').$type<RowPlan>(),
    /** `plan.verdict`, copied out so the report counts without reading jsonb. */
    verdict: text('verdict').$type<ImportVerdict>(),
    /** The record the commit wrote or matched; null until commit. */
    entityId: uuid('entity_id').references(() => entity.id),
    error: text('error'),
  },
  (t) => [uniqueIndex('import_row_batch_row_unique').on(t.batchId, t.rowNum)],
)
