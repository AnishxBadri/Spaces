import { isLedgerPlan } from './ledger'
import { ledgerOutcomeParts } from './ledger-commit'
import type {
  ImportAlsoCreate,
  ImportReference,
  RowPlan,
} from '@spaces/db/schema/import'

/**
 * **Idempotent commit** (SPA-169, project 14 `import-7`) — the rules the
 * commit decides without a query. The database half — the worker job that
 * replays each row through its creator in its own transaction — is
 * `apps/web/src/lib/import/commit.ts`; here is what two rows folded into one
 * write carry, what a row's outcome is called once the job has passed it,
 * and the counts the batch page reads.
 */

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * A `merged` row writes nothing itself: its values fold into the row it
 * merged into, **blanks only, first wins** — the surviving row's own cells
 * always stand, and among the rows folding in, the earlier row's cell wins.
 * Identity keys fold the same way; references and secondary creates follow
 * their cells, so a reference only the folded row named still lands, and a
 * create only it carried is still made.
 */
export function foldInto(survivor: RowPlan, folded: ReadonlyArray<RowPlan>) {
  const patch = { ...survivor.patch }
  const identity = { ...survivor.identity }
  const references: Array<ImportReference> = [...(survivor.references ?? [])]
  const alsoCreates: Array<ImportAlsoCreate> = [...(survivor.alsoCreates ?? [])]
  const named = new Set(references.map((r) => r.attributeId))
  for (const plan of folded) {
    for (const [attributeId, value] of Object.entries(plan.patch))
      if (!(attributeId in patch)) patch[attributeId] = value
    for (const [key, value] of Object.entries(plan.identity))
      if (!(key in identity)) Object.assign(identity, { [key]: value })
    for (const ref of plan.references ?? []) {
      if (named.has(ref.attributeId)) continue
      // A hit is already in the patch; a create is not, until it is made.
      if (ref.to !== 'create' && !(ref.attributeId in plan.patch)) continue
      named.add(ref.attributeId)
      references.push(ref)
    }
    for (const entry of plan.alsoCreates ?? [])
      if (!alsoCreates.some((a) => a.key === entry.key)) alsoCreates.push(entry)
  }
  const out: RowPlan = { ...survivor, patch, identity }
  if (references.length > 0) out.references = references
  if (alsoCreates.length > 0) out.alsoCreates = alsoCreates
  return out
}

/**
 * Every landing row's plan with its merged rows folded in, by row number,
 * rows in sheet order so "first" means the sheet's first.
 */
export function foldMerged(
  rows: ReadonlyArray<{ rowNum: number; plan: RowPlan }>,
): Map<number, { plan: RowPlan; folded: Array<number> }> {
  const byTarget = new Map<number, Array<{ rowNum: number; plan: RowPlan }>>()
  const sorted = [...rows].sort((a, b) => a.rowNum - b.rowNum)
  for (const row of sorted) {
    const into = row.plan.mergedInto
    if (row.plan.verdict !== 'merged' || into === undefined) continue
    byTarget.set(into, [...(byTarget.get(into) ?? []), row])
  }
  const out = new Map<number, { plan: RowPlan; folded: Array<number> }>()
  for (const row of sorted) {
    if (row.plan.verdict !== 'attach' && row.plan.verdict !== 'create') continue
    const folded = byTarget.get(row.rowNum) ?? []
    out.set(row.rowNum, {
      plan: foldInto(
        row.plan,
        folded.map((f) => f.plan),
      ),
      folded: folded.map((f) => f.rowNum),
    })
  }
  return out
}

/** The create keys a row's references need made before it lands. */
export function createKeysOf(plan: RowPlan): Array<string> {
  const keys = new Set<string>()
  for (const ref of plan.references ?? [])
    if (ref.to === 'create') keys.add(ref.key)
  return [...keys]
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** What the commit did with one row, as the batch page's outcome lane prints it. */
export type CommitOutcome =
  | { kind: 'created'; entityId: string }
  | { kind: 'attached'; entityId: string }
  /**
   * A ledger row (SPA-171): the events it appended onto the company's
   * holding, as the lane prints them.
   */
  | {
      kind: 'appended'
      entityId: string
      holdingId: string
      parts: Array<string>
    }
  /** A merged row: its values landed on row `into`'s record. */
  | { kind: 'folded'; into: number; entityId: string | null }
  | { kind: 'failed'; reason: string }
  /** Nothing to write, by decision or because the row never read. */
  | { kind: 'skipped'; reason: string }
  /** A landing row the job has not reached. */
  | { kind: 'pending' }

export const SKIP_BOTH_REASON = 'both rows skipped by decision'

export function commitOutcomeOf(row: {
  plan: RowPlan
  entityId: string | null
  error: string | null
}): CommitOutcome {
  const { plan, entityId, error } = row
  if (error !== null) return { kind: 'failed', reason: error }
  switch (plan.verdict) {
    case 'merged':
      return { kind: 'folded', into: plan.mergedInto ?? 0, entityId }
    case 'skip':
      return { kind: 'skipped', reason: plan.skipReason ?? SKIP_BOTH_REASON }
    case 'no-land':
      return {
        kind: 'skipped',
        reason: plan.errors.at(0)?.reason ?? 'does not read',
      }
    case 'collide':
      return { kind: 'pending' }
    case 'attach':
    case 'create':
      if (entityId === null) return { kind: 'pending' }
      if (isLedgerPlan(plan)) {
        const committed = plan.ledger.committed
        if (!committed) return { kind: 'pending' }
        return {
          kind: 'appended',
          entityId,
          holdingId: committed.holdingId,
          parts: ledgerOutcomeParts(plan),
        }
      }
      return (plan.committedAs ?? plan.verdict) === 'attach'
        ? { kind: 'attached', entityId }
        : { kind: 'created', entityId }
  }
}

/** The batch page's strip — `WRITTEN · ATTACHED · FAILED · REMAINING`. */
export type CommitCounts = {
  written: number
  attached: number
  failed: number
  remaining: number
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/** What one run of the job did — its `job_run.summary`. */
export type CommitRun = {
  written: number
  attached: number
  failed: number
  /** Rows that already held a record: a re-run writes nothing for them. */
  unchanged: number
}

export const emptyRun = (): CommitRun => ({
  written: 0,
  attached: 0,
  failed: 0,
  unchanged: 0,
})

/**
 * The run's line on `job_run.summary`: `batch <id> · 3 written · 1 attached
 * · 0 failed · 46 unchanged`. The batch id leads because `job_run` carries no
 * batch column — the line is how the batch page finds its own last run.
 */
export function commitRunLine(batchId: string, run: CommitRun): string {
  return `${runLinePrefix(batchId)}${run.written} written · ${run.attached} attached · ${run.failed} failed · ${run.unchanged} unchanged`
}

export function runLinePrefix(batchId: string): string {
  return `batch ${batchId} · `
}
