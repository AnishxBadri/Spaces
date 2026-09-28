import { Effect } from 'effect'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, importBatch, importRow } from '@spaces/db/schema'
import { CORE_IDENTITY_KEYS } from '@spaces/core/attributes/registry'
import { fitMapping } from '@spaces/core/import/mapping'
import {
  NEEDS_NAME,
  applyDecision,
  assignCreates,
  countsFrom,
  creatorFor,
  planRows,
  readRow,
  withReferences,
} from '@spaces/core/import/plan'
import {
  normalizeIdentityValue,
  normalizeKeys,
  previewResolve,
} from '#/lib/entities/resolve'
import { mappingObjectOf, mappingProblemsOf, readColumns } from './mapping'
import { lookupReferences, referenceColumnsOf } from './references'
import { ImportFailed, ImportNotFound, ImportRefused, clearPlan } from './stage'
import type {
  CoreIdentityKey,
  ObjectKind,
} from '@spaces/core/attributes/registry'
import type { Mapping } from '@spaces/core/import/mapping'
import type {
  CollisionDecision,
  ImportVerdict,
  PlanCounts,
  PlannedRow,
  ReadRow,
  Resolved,
  RowInput,
  RowPlan,
} from '@spaces/core/import/plan'
import type { ImportFailure } from './stage'

/**
 * **Resolve preview** (SPA-167, import-5) — the wizard's third step. Every
 * staged row is read under the mapping, looked up through `previewResolve`
 * (the read-only twin of `resolveEntity`'s step 1) and given a stored plan:
 * its verdict, its coerced patch, its errors. The plan is the dry run — the
 * report is drawn from it and the commit (SPA-169) replays it, so the two
 * cannot disagree. Nothing here writes to the graph: no entity, no alias, no
 * duplicate candidate; only `import_row.plan` / `verdict` and the batch's
 * status.
 *
 * Beside `stage.ts` and outside `lib/server/` for the barrel's reason
 * (CLAUDE.md → Traps).
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ImportFailed({ cause }) })

/** The sentence a caller shows for a preview failure. */
export function planMessage(failure: unknown): string {
  if (failure instanceof ImportRefused) return failure.reason
  if (failure instanceof ImportNotFound) return 'This import no longer exists'
  return 'Could not preview this import'
}

/** Rows per `update … from (values …)` statement. */
const UPDATE_CHUNK = 500

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function writePlans(
  tx: Tx,
  batchId: string,
  rows: ReadonlyArray<PlannedRow>,
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

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * The normalised identity a row carries, as its creator compares it: the
 * resolver's own `normalizeKeys` for people and companies (so a person's
 * role email drops out exactly as it would on the write), the identity
 * normalizers for a custom object's declared keys, nothing for a deal.
 */
function identityOf(
  kind: ObjectKind | null,
  read: ReadRow,
): Partial<Record<CoreIdentityKey, string>> {
  const out: Partial<Record<CoreIdentityKey, string>> = {}
  if (kind === 'company' || kind === 'person') {
    for (const k of normalizeKeys({ kind, keys: read.keys }))
      out[k.kind] = k.valueNorm
    return out
  }
  if (kind === 'deal') return out
  for (const k of CORE_IDENTITY_KEYS) {
    const raw = read.keys[k]
    if (raw === undefined) continue
    const norm = normalizeIdentityValue(k, raw)
    if (norm) out[k] = norm
  }
  return out
}

/**
 * What the creator would do. People and companies ask `previewResolve`;
 * a deal and a custom record have no attach door — their creators always
 * birth — and refuse only a missing name.
 */
const resolveRow = Effect.fn('resolveImportRow')(function* (
  kind: ObjectKind | null,
  read: ReadRow,
): Effect.fn.Return<Resolved | null, ImportFailed> {
  if (read.errors.length > 0) return null
  if (kind === 'company' || kind === 'person') {
    return yield* query(() =>
      previewResolve({
        kind,
        keys: read.keys,
        ...(read.name !== null ? { name: read.name } : {}),
      }),
    )
  }
  return read.name === null
    ? { verdict: 'refused', reason: NEEDS_NAME }
    : { verdict: 'create' }
})

export type PlanImportResult = { counts: PlanCounts }

/**
 * Continue from step 2: refuse a mapping that would not advance, then plan
 * every row and store it — the rows' plans and the batch's `planned`
 * status in one transaction. The transaction re-reads the batch under a
 * row lock and refuses when its mapping moved while the rows were being
 * looked up, so a plan is only ever stored against the mapping it was
 * computed from. A planned batch answers with its counts and plans nothing.
 */
export const planImportProgram = Effect.fn('planImportProgram')(function* (
  batchId: string,
): Effect.fn.Return<PlanImportResult, ImportFailure> {
  const batch = yield* query(() =>
    db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
      .then((rows) => rows.at(0)),
  )
  if (!batch) return yield* new ImportNotFound()
  if (batch.status === 'planned') return { counts: yield* countsOf(batchId) }
  if (batch.status !== 'staged')
    return yield* new ImportRefused({
      reason: `This import is ${batch.status} and can no longer change`,
    })
  if (
    batch.mode !== 'records' ||
    batch.targetObjectId === null ||
    batch.mapping === null
  )
    return yield* new ImportRefused({
      reason: 'Map the columns before the preview',
    })
  const object = yield* mappingObjectOf(batch.targetObjectId)
  const rows = yield* query(() =>
    db
      .select({ rowNum: importRow.rowNum, cells: importRow.cells })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum)),
  )
  const width = batch.header?.length ?? rows.at(0)?.cells.length ?? 0
  const mapping = fitMapping(batch.mapping, width)
  const problems = mappingProblemsOf(
    mapping,
    object.registry,
    batch.header,
    readColumns(mapping, object.registry, rows),
  )
  const first = problems.at(0)
  if (first) return yield* new ImportRefused({ reason: first.reason })

  // Reference cells (SPA-168): every distinct cell looked up once, exactly.
  const refColumns = yield* referenceColumnsOf(mapping, object.registry)
  const lookup = yield* lookupReferences(refColumns, rows)

  const inputs: Array<RowInput> = []
  for (const row of rows) {
    const read = withReferences(
      readRow(row.cells, mapping, object.registry),
      refColumns,
      lookup,
    )
    inputs.push({
      rowNum: row.rowNum,
      read,
      identity: identityOf(object.kind, read),
      resolved: yield* resolveRow(object.kind, read),
    })
  }
  const nameColumn = mapping.findIndex((t) => t.target === 'name')
  const planned = planRows(inputs, creatorFor(object.kind), nameColumn)

  const stored = yield* query(() =>
    db.transaction(async (tx) => {
      const now = (
        await tx
          .select({ mapping: importBatch.mapping, status: importBatch.status })
          .from(importBatch)
          .where(eq(importBatch.id, batchId))
          .for('update')
      ).at(0)
      if (
        !now ||
        now.status !== 'staged' ||
        !sameMapping(now.mapping, mapping, width)
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
  return { counts: yield* countsOf(batchId) }
})

function sameMapping(
  stored: Mapping | null,
  planned: Mapping,
  width: number,
): boolean {
  return (
    stored !== null &&
    JSON.stringify(fitMapping(stored, width)) === JSON.stringify(planned)
  )
}

/** The batch's counts, from the verdict column and the plans' skipped cells. */
const countsOf = (batchId: string) =>
  query(() =>
    db
      .select({
        verdict: importRow.verdict,
        rows: sql<number>`count(*)::int`,
        skippedCells: sql<number>`coalesce(sum(jsonb_array_length(${importRow.plan} -> 'skippedCells')), 0)::int`,
        alsoCreates: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${importRow.plan} -> 'alsoCreates', '[]'::jsonb))), 0)::int`,
      })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .groupBy(importRow.verdict)
      .then((tallies) =>
        countsFrom(
          tallies.flatMap((t) =>
            t.verdict === null
              ? []
              : [
                  {
                    verdict: t.verdict,
                    rows: t.rows,
                    skippedCells: t.skippedCells,
                    alsoCreates: t.alsoCreates,
                  },
                ],
          ),
        ),
      ),
  )

// ---------------------------------------------------------------------------
// Back to mapping
// ---------------------------------------------------------------------------

/** Step 3 → 2: the plan goes, and the batch is staged again. */
export const reopenImportMappingProgram = Effect.fn(
  'reopenImportMappingProgram',
)(function* (batchId: string): Effect.fn.Return<void, ImportFailure> {
  const batch = yield* plannedBatch(batchId)
  yield* query(() => db.transaction((tx) => clearPlan(tx, batch.id)))
})

const plannedBatch = Effect.fn('plannedBatch')(function* (batchId: string) {
  const batch = yield* query(() =>
    db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
      .then((rows) => rows.at(0)),
  )
  if (!batch) return yield* new ImportNotFound()
  if (batch.status !== 'planned')
    return yield* new ImportRefused({
      reason:
        batch.status === 'staged'
          ? 'The preview is out of date — continue from the mapping'
          : `This import is ${batch.status} and can no longer change`,
    })
  return batch
})

// ---------------------------------------------------------------------------
// A collision's decision
// ---------------------------------------------------------------------------

/**
 * Store what the operator decided for one in-file collision, on every row
 * of it (and the rows that merged silently into them). The rows are locked
 * with the batch, so two decisions cannot interleave. Every row that names a
 * secondary create is read too, and the creates re-carried after the
 * decision (SPA-168): a carrier the decision skips hands its creates on.
 */
export const decideImportCollisionProgram = Effect.fn(
  'decideImportCollisionProgram',
)(function* (input: {
  batchId: string
  rowNum: number
  decision: CollisionDecision
}): Effect.fn.Return<PlanImportResult, ImportFailure> {
  yield* plannedBatch(input.batchId)
  const changed = yield* query(() =>
    db.transaction(async (tx) => {
      const locked = (
        await tx
          .select({ status: importBatch.status })
          .from(importBatch)
          .where(eq(importBatch.id, input.batchId))
          .for('update')
      ).at(0)
      if (locked?.status !== 'planned') return null
      const rows = (
        await tx
          .select({ rowNum: importRow.rowNum, plan: importRow.plan })
          .from(importRow)
          .where(
            and(
              eq(importRow.batchId, input.batchId),
              sql`(jsonb_exists(${importRow.plan}, 'collidesWith') or jsonb_exists(${importRow.plan}, 'mergedInto') or ${importRow.plan} -> 'references' @> '[{"to":"create"}]'::jsonb)`,
            ),
          )
      ).flatMap((r) => (r.plan ? [{ rowNum: r.rowNum, plan: r.plan }] : []))
      const next = applyDecision(rows, input.rowNum, input.decision)
      if (next.length === 0) return 0
      const decided = new Map(next.map((r) => [r.rowNum, r.plan]))
      const carried = assignCreates(
        rows.map((r) => ({
          rowNum: r.rowNum,
          plan: decided.get(r.rowNum) ?? r.plan,
        })),
      )
      const before = new Map(rows.map((r) => [r.rowNum, r.plan]))
      await writePlans(
        tx,
        input.batchId,
        carried.filter(
          (r) =>
            JSON.stringify(r.plan) !== JSON.stringify(before.get(r.rowNum)),
        ),
      )
      return next.length
    }),
  )
  if (changed === null)
    return yield* new ImportRefused({
      reason: 'The preview is out of date — continue from the mapping',
    })
  if (changed === 0)
    return yield* new ImportRefused({
      reason: `Row ${input.rowNum} is not in a collision`,
    })
  return { counts: yield* countsOf(input.batchId) }
})

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const PREVIEW_FILTERS = [
  'all',
  'create',
  'attach',
  'decide',
  'noland',
] as const

export type PreviewFilter = (typeof PREVIEW_FILTERS)[number]

/** Ledger rows the report draws before its `+ N more` fold. */
export const LEDGER_ROWS = 200

export type PreviewRow = { rowNum: number; cells: Array<string>; plan: RowPlan }

export type ImportPreviewView = {
  counts: PlanCounts
  filter: PreviewFilter
  /** The first `LEDGER_ROWS` rows the filter matches, in sheet order. */
  rows: Array<PreviewRow>
  /** Rows the filter matches in all. */
  matching: number
  /** Every row of a collision a drawn row belongs to, drawn or not. */
  collisionRows: Array<PreviewRow>
  /** Attach targets by id — the name the right lane links. */
  matched: Record<string, string>
  object: { kind: ObjectKind | null; slug: string; plural: string }
  header: Array<string> | null
}

function filterWhere(filter: PreviewFilter) {
  const verdict = (...v: Array<ImportVerdict>) => inArray(importRow.verdict, v)
  switch (filter) {
    case 'all':
      return undefined
    case 'create':
      // A row carrying a secondary create shows it under create too.
      return or(
        verdict('create'),
        sql`jsonb_exists(${importRow.plan}, 'alsoCreates')`,
      )
    case 'attach':
      return verdict('attach')
    case 'noland':
      return verdict('no-land')
    case 'decide':
      return sql`jsonb_exists(${importRow.plan}, 'collidesWith')`
  }
}

/**
 * Step 3's data, read off the stored plans — null unless the batch is
 * planned, so a batch whose mapping moved shows no verdict at all rather
 * than an old one.
 */
export const loadImportPreviewProgram = Effect.fn('loadImportPreviewProgram')(
  function* (input: {
    batchId: string
    filter: PreviewFilter
  }): Effect.fn.Return<ImportPreviewView | null, ImportFailure> {
    const batch = yield* query(() =>
      db
        .select()
        .from(importBatch)
        .where(eq(importBatch.id, input.batchId))
        .then((rows) => rows.at(0)),
    )
    if (!batch) return yield* new ImportNotFound()
    if (batch.status !== 'planned' || batch.targetObjectId === null) return null
    const object = yield* mappingObjectOf(batch.targetObjectId)
    const where = and(
      eq(importRow.batchId, input.batchId),
      filterWhere(input.filter),
    )
    const toRows = (
      found: Array<{
        rowNum: number
        cells: Array<string>
        plan: RowPlan | null
      }>,
    ): Array<PreviewRow> =>
      found.flatMap((r) =>
        r.plan ? [{ rowNum: r.rowNum, cells: r.cells, plan: r.plan }] : [],
      )
    const rows = toRows(
      yield* query(() =>
        db
          .select({
            rowNum: importRow.rowNum,
            cells: importRow.cells,
            plan: importRow.plan,
          })
          .from(importRow)
          .where(where)
          .orderBy(asc(importRow.rowNum))
          .limit(LEDGER_ROWS),
      ),
    )
    const matching = yield* query(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(importRow)
        .where(where)
        .then((r) => r.at(0)?.n ?? 0),
    )
    const members = [
      ...new Set(rows.flatMap((r) => r.plan.collidesWith ?? [])),
    ].filter((n) => !rows.some((r) => r.rowNum === n))
    const collisionRows =
      members.length === 0
        ? []
        : toRows(
            yield* query(() =>
              db
                .select({
                  rowNum: importRow.rowNum,
                  cells: importRow.cells,
                  plan: importRow.plan,
                })
                .from(importRow)
                .where(
                  and(
                    eq(importRow.batchId, input.batchId),
                    inArray(importRow.rowNum, members),
                  ),
                )
                .orderBy(asc(importRow.rowNum)),
            ),
          )
    const ids = [
      ...new Set(
        [...rows, ...collisionRows].flatMap((r) =>
          r.plan.entityId === undefined ? [] : [r.plan.entityId],
        ),
      ),
    ]
    const names =
      ids.length === 0
        ? []
        : yield* query(() =>
            db
              .select({ id: entity.id, name: entity.canonicalName })
              .from(entity)
              .where(inArray(entity.id, ids)),
          )
    return {
      counts: yield* countsOf(input.batchId),
      filter: input.filter,
      rows,
      matching,
      collisionRows,
      matched: Object.fromEntries(names.map((n) => [n.id, n.name])),
      object: { kind: object.kind, slug: object.slug, plural: object.plural },
      header: batch.header,
    }
  },
)
