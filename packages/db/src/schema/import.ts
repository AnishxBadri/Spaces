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
 * Staged import: a spreadsheet becomes a batch plus one row per data row.
 * - Nothing reaches the graph before commit — no entity, document or edge —
 *   and only the commit stamps `entity_id`.
 * - The payload is a blob, not a document, so it is never extracted, chunked
 *   or embedded. `blob_sha` is plain text: storage is keyed by the digest.
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
 * plan; a mapping change returns it to `staged`.
 */
export const importBatchStatus = pgEnum('import_batch_status', [
  'staged',
  'planned',
  'committed',
  'failed',
])

export type ImportBatchStatus = (typeof importBatchStatus.enumValues)[number]

/**
 * `import_batch.mapping`: one target per source column, by index. Core's
 * import mapping owns the behaviour.
 * - `name` — the record's name (exactly one column). `identity` — one of the
 *   object's identity keys. `ignore` — not imported.
 * - `attribute` — a live attribute. `dateOrder` is declared, never sniffed;
 *   `createMissing` (`record_reference` only, default off) plans a record of
 *   the referenced object for a cell that names none.
 * - `new` — an attribute not yet confirmed; confirming creates it and the
 *   column becomes an `attribute` target. `options` seed a select.
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
// Ledger mode
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
 * A ledger column's target. Decisions ride on the column they are about, so
 * a re-plan reads the same answer and a moved column starts over.
 * - `dateOrder` on every date field. `createMissing` on `company`: an
 *   unmatched company is planned as a create.
 * - `instrumentMap` on `instrument`: `instrumentKey` → resolution;
 *   `instrumentByRow` holds the values resolved `per_row`.
 * - `currency` on `amount`, `marksAsOf` on `markValue`: the value for a row
 *   that names none.
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
 * A row's verdict, stored in `import_row.plan` so the commit replays the
 * preview rather than recomputing an answer that could disagree with it.
 * - `attach` matched a live record · `create` no match · `skip` a decided
 *   collision's `skip-both`.
 * - `collide` shares a key with another row under another name and waits on
 *   a `decision`; keeps `entityId`/`matchedOn` so a decision can restore them.
 * - `merged` folds into `mergedInto` (same key and name, or a collision's
 *   loser), counted once there.
 * - `no-land` cannot be written as it stands; `errors` say why.
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
 * A reference cell the plan settled: the record it found, the
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
  /** Reference cells that resolved, or plan a create. */
  references?: Array<ImportReference>
  /** Records of referenced objects this row creates first. */
  alsoCreates?: Array<ImportAlsoCreate>
  /**
   * What the commit's creator actually did, stored only when it differs from
   * `verdict` (a record born after the preview turns a create into an attach).
   */
  committedAs?: 'attach' | 'create'
  /** The records this row's `alsoCreates` became, by create key. */
  alsoCreated?: Record<string, string>
  /** Why the commit wrote nothing for a row that was never going to. */
  skipReason?: string
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

/** A ledger event kind, as the commit records what it reused. */
export type LedgerEventKind = 'round' | 'investment' | 'mark' | 'distribution'

/**
 * What the commit did with a ledger row, written onto its plan in the row's
 * own transaction.
 * - A row holding it is passed over by every later run: a re-run appends
 *   nothing.
 * - Ids are events this commit appended, or existing live rows with the same
 *   natural key (named in `reused`).
 * - `roundId` is how the receipt names the round: a round has no `batch_id`.
 *   (D12)
 */
export type LedgerCommitted = {
  holdingId: string
  /** This row's cheque opened the company's holding. */
  holdingBorn: boolean
  roundId?: string
  investmentId: string
  markId?: string
  distributionId?: string
  /** Events matched to an existing live row by natural key, not appended. */
  reused?: Array<LedgerEventKind>
}

export type LedgerPlan = {
  /** The company across the batch: `entity:<id>` or a create's key. */
  company: string | null
  /** This row births the company's holding — one row per company, at most. */
  birthsHolding: boolean
  /** Null when the row does not land. */
  events: LedgerEvents | null
  /** Decisions whose absence stops the row. */
  needs: Array<LedgerNeed>
  /** Set by the commit once the row's events landed. */
  committed?: LedgerCommitted
}

/**
 * A ledger row's plan: the records plan's frame — the verdict says
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
