import { Effect } from 'effect'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { holding, importBatch, importRow, objectDef } from '@spaces/db/schema'
import {
  CORE_OBJECTS,
  coreKindOf,
  identityKeysOf,
} from '@spaces/core/attributes/registry'
import {
  applyLedgerDecision,
  assignLedgerField,
  autoMapLedger,
  companyColumnOf,
  countLedger,
  instrumentCandidates,
  instrumentKey,
  isLedgerPlan,
  ledgerColumnsOf,
  ledgerDecisionsOf,
  ledgerReport,
  ledgerWhy,
  planLedgerBatch,
  resolveInstrument,
  summarizeLedger,
  validateLedgerMapping,
} from '@spaces/core/import/ledger'
import { fitMapping } from '@spaces/core/import/mapping'
import { creatorFor } from '@spaces/core/import/plan'
import { referenceKey } from '@spaces/core/import/references'
import { lookupReferences } from './references'
import {
  COMMITTING,
  ImportFailed,
  ImportNotFound,
  ImportRefused,
  clearPlan,
  commitStarted,
} from './stage'
import type {
  CompanyTarget,
  LedgerCompanyReport,
  LedgerContext,
  LedgerCounts,
  LedgerDecision,
  LedgerField,
  LedgerInstrument,
  LedgerRowPlan,
  LedgerSummary,
  PlannedLedgerRow,
} from '@spaces/core/import/ledger'
import type {
  Mapping,
  MappingProblem,
  Replaced,
} from '@spaces/core/import/mapping'
import type { ReferenceOutcome } from '@spaces/core/import/references'
import type { ImportFailure } from './stage'

/**
 * **Ledger mapping** (SPA-170, import-8) — the database half of the ledger
 * import's mapping and preview steps. The rules are
 * `@spaces/core/import/ledger`'s; this module reads the batch, looks up the
 * company column through the SPA-168 reference matcher (exact only), asks
 * which of the found companies already hold a position, and stores each
 * row's plan on `import_row.plan`.
 *
 * **Nothing here writes to `round`, `investment`, `mark` or
 * `distribution`** — the commit is `./ledger-commit`'s (SPA-171). Outside `lib/server/` for the
 * barrel's reason (CLAUDE.md → Traps).
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ImportFailed({ cause }) })

/** The sentence a caller shows for a ledger-step failure. */
export function ledgerMessage(failure: unknown): string {
  if (failure instanceof ImportRefused) return failure.reason
  if (failure instanceof ImportNotFound) return 'This import no longer exists'
  return 'Could not save the ledger mapping'
}

type Batch = typeof importBatch.$inferSelect
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const batchOf = (batchId: string) =>
  query(() =>
    db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
      .then((rows) => rows.at(0)),
  )

const rowsOf = (batchId: string) =>
  query(() =>
    db
      .select({ rowNum: importRow.rowNum, cells: importRow.cells })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum)),
  )

function widthOf(batch: Batch, rows: ReadonlyArray<{ cells: Array<string> }>) {
  return batch.header?.length ?? rows.at(0)?.cells.length ?? 0
}

/** A ledger batch the wizard may still change: staged, or planned. */
const editableLedger = Effect.fn('editableLedger')(function* (
  batchId: string,
): Effect.fn.Return<Batch, ImportFailure> {
  const batch = yield* batchOf(batchId)
  if (!batch) return yield* new ImportNotFound()
  if (batch.mode !== 'ledger')
    return yield* new ImportRefused({
      reason: 'This import fills records, not the ledger',
    })
  if (batch.status !== 'staged' && batch.status !== 'planned')
    return yield* new ImportRefused({
      reason: `This import is ${batch.status} and can no longer change`,
    })
  // A plan the commit is replaying must not move under it (SPA-171).
  if (batch.status === 'planned' && (yield* commitStarted(batch.id)))
    return yield* new ImportRefused({ reason: COMMITTING })
  return batch
})

/** Every mapping write clears the plan, as in records mode (SPA-167). */
const writeMapping = (batchId: string, mapping: Mapping) =>
  query(() =>
    db.transaction(async (tx) => {
      await tx
        .update(importBatch)
        .set({ mapping })
        .where(eq(importBatch.id, batchId))
      await clearPlan(tx, batchId)
    }),
  )

// ---------------------------------------------------------------------------
// The company lookup
// ---------------------------------------------------------------------------

/** The Companies object, as the reference matcher points at it. */
const companyTarget = query(async (): Promise<CompanyTarget> => {
  const row = (
    await db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
        isSystem: objectDef.isSystem,
        archived: objectDef.archived,
        identityKeys: objectDef.identityKeys,
      })
      .from(objectDef)
      .where(
        and(
          eq(objectDef.slug, CORE_OBJECTS.company.slug),
          eq(objectDef.isSystem, true),
        ),
      )
  ).at(0)
  if (!row || row.archived) return null
  const kind = coreKindOf(row)
  return {
    objectId: row.id,
    kind,
    singular: row.singular,
    plural: row.plural,
    identityKeys: identityKeysOf(row),
    creator: creatorFor(kind),
  }
})

/**
 * What the planner needs from the database: the company column looked up
 * (every distinct cell once, exactly), and which of the companies it found
 * already hold a position.
 */
const contextOf = Effect.fn('ledgerContextOf')(function* (
  mapping: Mapping,
  rows: ReadonlyArray<{ cells: ReadonlyArray<string> }>,
): Effect.fn.Return<LedgerContext, ImportFailed> {
  const company = yield* companyTarget
  const column = companyColumnOf(ledgerColumnsOf(mapping), company)
  const lookup = column
    ? yield* lookupReferences(new Map([[column.column, column]]), rows)
    : new Map<number, Map<string, ReferenceOutcome>>()
  const ids = new Set<string>()
  for (const outcomes of lookup.values())
    for (const o of outcomes.values())
      if (o.status === 'found') ids.add(o.entityId)
  const held =
    ids.size === 0
      ? []
      : yield* query(() =>
          db
            .select({ companyId: holding.companyId })
            .from(holding)
            .where(inArray(holding.companyId, [...ids])),
        )
  return { company, lookup, held: new Set(held.map((h) => h.companyId)) }
})

// ---------------------------------------------------------------------------
// Enter and change
// ---------------------------------------------------------------------------

/** Continue from step 1: the first guess from the header, written to the batch. */
export const beginLedgerMappingProgram = Effect.fn('beginLedgerMappingProgram')(
  function* (batchId: string): Effect.fn.Return<Mapping, ImportFailure> {
    const batch = yield* editableLedger(batchId)
    const rows = yield* rowsOf(batchId)
    const width = widthOf(batch, rows)
    if (batch.mapping !== null) return fitMapping(batch.mapping, width)
    const headers = batch.header ?? Array.from({ length: width }, () => '')
    const mapping = fitMapping(autoMapLedger(headers), width)
    yield* writeMapping(batchId, mapping)
    return mapping
  },
)

const mappedLedger = Effect.fn('mappedLedger')(function* (batchId: string) {
  const batch = yield* editableLedger(batchId)
  if (batch.mapping === null)
    return yield* new ImportRefused({
      reason: 'Continue to the mapping step first',
    })
  const rows = yield* rowsOf(batchId)
  const width = widthOf(batch, rows)
  return { batch, width, mapping: fitMapping(batch.mapping, width) }
})

/** One event field onto one sheet column, or off the sheet. */
export const mapLedgerFieldProgram = Effect.fn('mapLedgerFieldProgram')(
  function* (input: {
    batchId: string
    field: LedgerField
    column: number | null
  }): Effect.fn.Return<{ replaced: Array<Replaced> }, ImportFailure> {
    const { width, mapping } = yield* mappedLedger(input.batchId)
    if (input.column !== null && (input.column < 0 || input.column >= width))
      return yield* new ImportRefused({
        reason: 'That column is not in the sheet',
      })
    const out = assignLedgerField(mapping, input.field, input.column)
    yield* writeMapping(input.batchId, out.mapping)
    return { replaced: out.replaced }
  },
)

/** One decision, written onto the column it is about. */
export const setLedgerDecisionProgram = Effect.fn('setLedgerDecisionProgram')(
  function* (input: {
    batchId: string
    decision: LedgerDecision
  }): Effect.fn.Return<void, ImportFailure> {
    const { mapping } = yield* mappedLedger(input.batchId)
    const out = applyLedgerDecision(mapping, input.decision)
    if (!out.ok) return yield* new ImportRefused({ reason: out.reason })
    yield* writeMapping(input.batchId, out.mapping)
  },
)

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const UPDATE_CHUNK = 500

async function writePlans(
  tx: Tx,
  batchId: string,
  rows: ReadonlyArray<PlannedLedgerRow>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPDATE_CHUNK) {
    const values = rows
      .slice(i, i + UPDATE_CHUNK)
      .map(
        (r) =>
          sql`(${r.rowNum}::int, ${JSON.stringify(r.plan)}::jsonb, ${r.plan.verdict}::text)`,
      )
    await tx.execute(sql`
      update ${importRow} as r
         set plan = v.plan, verdict = v.verdict
        from (values ${sql.join(values, sql`, `)}) as v(row_num, plan, verdict)
       where r.batch_id = ${batchId} and r.row_num = v.row_num`)
  }
}

/** Every stored ledger plan of a batch, in sheet order. */
const storedPlans = (batchId: string) =>
  query(() =>
    db
      .select({
        rowNum: importRow.rowNum,
        cells: importRow.cells,
        plan: importRow.plan,
      })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum)),
  ).pipe(
    Effect.map((rows) =>
      rows.flatMap((r) =>
        r.plan && isLedgerPlan(r.plan)
          ? [{ rowNum: r.rowNum, cells: r.cells, plan: r.plan }]
          : [],
      ),
    ),
  )

export type PlanLedgerResult = { counts: LedgerCounts }

/**
 * Continue from step 2: refuse a mapping that would not advance, then plan
 * every row and store it with the batch's `planned` status in one
 * transaction — which re-reads the mapping under a row lock and refuses
 * when it moved while the company column was being looked up.
 */
export const planLedgerImportProgram = Effect.fn('planLedgerImportProgram')(
  function* (
    batchId: string,
  ): Effect.fn.Return<PlanLedgerResult, ImportFailure> {
    const batch = yield* batchOf(batchId)
    if (!batch) return yield* new ImportNotFound()
    if (batch.mode !== 'ledger')
      return yield* new ImportRefused({
        reason: 'This import fills records, not the ledger',
      })
    if (batch.status === 'planned')
      return {
        counts: countLedger((yield* storedPlans(batchId)).map((r) => r.plan)),
      }
    if (batch.status !== 'staged')
      return yield* new ImportRefused({
        reason: `This import is ${batch.status} and can no longer change`,
      })
    if (batch.mapping === null)
      return yield* new ImportRefused({
        reason: 'Map the columns before the preview',
      })
    const rows = yield* rowsOf(batchId)
    const width = widthOf(batch, rows)
    const mapping = fitMapping(batch.mapping, width)
    const first = validateLedgerMapping(mapping).at(0)
    if (first) return yield* new ImportRefused({ reason: first.reason })
    const planned = planLedgerBatch(
      rows,
      mapping,
      yield* contextOf(mapping, rows),
    )
    const stored = yield* query(() =>
      db.transaction(async (tx) => {
        const now = (
          await tx
            .select({
              mapping: importBatch.mapping,
              status: importBatch.status,
            })
            .from(importBatch)
            .where(eq(importBatch.id, batchId))
            .for('update')
        ).at(0)
        if (
          !now ||
          now.status !== 'staged' ||
          now.mapping === null ||
          JSON.stringify(fitMapping(now.mapping, width)) !==
            JSON.stringify(mapping)
        )
          return false
        await writePlans(tx, batchId, planned)
        await tx
          .update(importBatch)
          .set({ status: 'planned' })
          .where(eq(importBatch.id, batchId))
        return true
      }),
    )
    if (!stored)
      return yield* new ImportRefused({
        reason: 'The mapping changed while the preview ran — continue again',
      })
    return { counts: countLedger(planned.map((r) => r.plan)) }
  },
)

/**
 * A row whose instrument is decided per row, decided from the preview: the
 * choice is stored on the mapping — so the next plan reads it — and the
 * batch is planned again at once, so the preview stays open.
 */
export const decideLedgerRowProgram = Effect.fn('decideLedgerRowProgram')(
  function* (input: {
    batchId: string
    rowNum: number
    instrument: LedgerInstrument
  }): Effect.fn.Return<PlanLedgerResult, ImportFailure> {
    yield* setLedgerDecisionProgram({
      batchId: input.batchId,
      decision: {
        kind: 'rowInstrument',
        rowNum: input.rowNum,
        instrument: input.instrument,
      },
    })
    return yield* planLedgerImportProgram(input.batchId)
  },
)

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

export type LedgerMappingView = {
  mapping: Mapping
  summary: LedgerSummary
  /** What the plan would make, from the same planner the preview stores. */
  counts: LedgerCounts
  /** Distinct company cells: found, planned as creates, and neither. */
  companies: { total: number; found: number; missing: number; other: number }
  problems: Array<MappingProblem>
}

export type LedgerFailedRow = {
  rowNum: number
  name: string | null
  why: string
  /** A `per_row` instrument still to choose: the cell and its candidates. */
  perRow: { raw: string; candidates: Array<LedgerInstrument> } | null
}

export type LedgerPreviewView = {
  counts: LedgerCounts
  /** The first `LEDGER_COMPANIES` companies, in sheet order. */
  companies: Array<LedgerCompanyReport>
  moreCompanies: number
  failed: Array<LedgerFailedRow>
  header: Array<string> | null
}

export type LedgerImportView = {
  mapping: LedgerMappingView | null
  preview: LedgerPreviewView | null
}

/** Companies the report draws before its `+ N more` fold. */
export const LEDGER_COMPANIES = 200

function failedRow(
  row: { rowNum: number; cells: Array<string>; plan: LedgerRowPlan },
  mapping: Mapping,
  header: Array<string> | null,
): LedgerFailedRow {
  const columns = ledgerColumnsOf(mapping)
  const instrument = columns.instrument
  const raw = instrument ? (row.cells.at(instrument.column) ?? '') : ''
  const key = instrumentKey(raw)
  const perRow =
    instrument &&
    row.plan.ledger.needs.includes('instrument') &&
    resolveInstrument(key, ledgerDecisionsOf(columns).instrumentMap)
      .resolution === 'per_row'
      ? { raw: raw.trim(), candidates: instrumentCandidates(key) }
      : null
  return {
    rowNum: row.rowNum,
    name: row.plan.name,
    why: ledgerWhy(row.plan, header),
    perRow,
  }
}

/**
 * The ledger steps' data: the mapping view on step 2, the preview on step 3,
 * neither on step 1. Null for a records batch.
 */
export const loadLedgerImportProgram = Effect.fn('loadLedgerImportProgram')(
  function* (
    batchId: string,
  ): Effect.fn.Return<LedgerImportView | null, ImportFailure> {
    const batch = yield* batchOf(batchId)
    if (!batch) return yield* new ImportNotFound()
    if (batch.mode !== 'ledger') return null
    // A committed batch is its receipt (SPA-171), not a step to edit.
    if (
      batch.mapping === null ||
      batch.status === 'committed' ||
      batch.status === 'failed'
    )
      return { mapping: null, preview: null }

    if (batch.status === 'planned') {
      const rows = yield* storedPlans(batchId)
      const width = widthOf(batch, rows)
      const mapping = fitMapping(batch.mapping, width)
      const companies = ledgerReport(rows)
      return {
        mapping: null,
        preview: {
          counts: countLedger(rows.map((r) => r.plan)),
          companies: companies.slice(0, LEDGER_COMPANIES),
          moreCompanies: Math.max(0, companies.length - LEDGER_COMPANIES),
          failed: rows
            .filter((r) => r.plan.verdict === 'no-land')
            .map((r) => failedRow(r, mapping, batch.header)),
          header: batch.header,
        },
      }
    }

    const rows = yield* rowsOf(batchId)
    const width = widthOf(batch, rows)
    const mapping = fitMapping(batch.mapping, width)
    const ctx = yield* contextOf(mapping, rows)
    const planned = planLedgerBatch(rows, mapping, ctx)
    const companyColumn = ledgerColumnsOf(mapping).company?.column
    const outcomes =
      companyColumn === undefined ? undefined : ctx.lookup.get(companyColumn)
    const distinct = new Set<string>()
    if (companyColumn !== undefined)
      for (const r of rows) {
        const raw = r.cells.at(companyColumn) ?? ''
        if (raw.trim() !== '') distinct.add(referenceKey(raw))
      }
    let found = 0
    let missing = 0
    for (const key of distinct) {
      const o = outcomes?.get(key)
      if (o?.status === 'found') found += 1
      else if (o?.status === 'missing') missing += 1
    }
    return {
      mapping: {
        mapping,
        summary: summarizeLedger(rows, mapping),
        counts: countLedger(planned.map((r) => r.plan)),
        companies: {
          total: distinct.size,
          found,
          missing,
          other: distinct.size - found - missing,
        },
        problems: validateLedgerMapping(mapping),
      },
      preview: null,
    }
  },
)
