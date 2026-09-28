import { normalizeName } from '../entities/normalize'
import {
  cellReason,
  columnLetter,
  columnName,
  readCell,
  specFor,
} from './mapping'
import type { CoreIdentityKey, ObjectKind } from '../attributes/registry'
import type { MappingRegistry } from './mapping'
import type {
  CollisionDecision,
  ImportCellIssue,
  ImportCellValue,
  ImportCreator,
  ImportVerdict,
  Mapping,
  RowPlan,
} from '@spaces/db/schema/import'

/**
 * **Resolve preview** (SPA-167, project 14 `import-5`) — the rules that turn
 * staged rows into stored plans, pure. The database half (the identity
 * lookup through `previewResolve`, persistence) is
 * `apps/web/src/lib/import/plan.ts`; everything decided without a query is
 * here: how one row reads under the mapping, which creator a row goes
 * through, and what two rows of one file claiming one identity key become —
 * the case `resolveEntity` cannot see, because the second row does not exist
 * yet when the first is written.
 *
 * The plan's shape is declared at `import_row.plan` and re-exported here.
 */
export type {
  CollisionDecision,
  ImportCellIssue,
  ImportCellValue,
  ImportCreator,
  ImportVerdict,
  RowPlan,
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

/**
 * The door a new record of this object goes through. `resolveEntity` owns
 * people and companies; a deal is born by its own path (`createDeal`), a
 * custom record by `createRecordProgram` — neither goes through the
 * resolver, so the plan names which one rather than implying one door.
 */
export function creatorFor(kind: ObjectKind | null): ImportCreator {
  if (kind === 'company' || kind === 'person') return 'resolveEntity'
  if (kind === 'deal') return 'dealBirth'
  return 'createRecordProgram'
}

/** How a creator reads in a row's why lane. */
export const CREATOR_LABELS: Record<ImportCreator, string> = {
  resolveEntity: 'resolveEntity',
  dealBirth: 'deal birth',
  createRecordProgram: 'createRecordProgram',
}

/**
 * The refusal of the two creators that are not the resolver — a deal and a
 * custom record both need a name at birth (`createRecordProgram`'s words).
 */
export const NEEDS_NAME = 'Every record needs a name'

/** The reason a reference cell is left out until SPA-168 matches it. */
export const REFERENCE_SKIP = 'reference · SPA-168'

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

export type ReadRow = {
  /** The name cell, trimmed; null when blank. */
  name: string | null
  /** Identity key → the cell as read (not yet normalised). */
  keys: Partial<Record<CoreIdentityKey, string>>
  patch: Record<string, ImportCellValue>
  /** A name cell that did not read — the only cell error that stops a row. */
  errors: Array<ImportCellIssue>
  /** Every other cell that did not read, with its reason; the row lands without it. */
  skippedCells: Array<ImportCellIssue>
}

/**
 * One staged row under the mapping: every mapped cell through the column's
 * spec (`readCell` — the coercer, or the CIN normalizer). **Red is a cell,
 * never a row** (SPA-166's contract): a cell that does not read is a
 * skipped cell with its reason, and the row still lands with that value
 * left blank — an identity cell included, in which case the row matches on
 * the keys that remain, or creates. A reference cell is skipped the same
 * way until SPA-168 resolves it. The one cell the row cannot exist without
 * is its name: a name cell that does not read is the row's error.
 */
export function readRow(
  cells: ReadonlyArray<string>,
  mapping: Mapping,
  registry: MappingRegistry,
): ReadRow {
  const out: ReadRow = {
    name: null,
    keys: {},
    patch: {},
    errors: [],
    skippedCells: [],
  }
  mapping.forEach((target, column) => {
    const spec = specFor(target, registry)
    if (spec === null || target.target === 'new') return
    const raw = cells.at(column) ?? ''
    if (
      spec.kind === 'typed' &&
      (spec.type === 'record_reference' || spec.type === 'actor_reference')
    ) {
      if (raw.trim() !== '')
        out.skippedCells.push({ column, raw, reason: REFERENCE_SKIP })
      return
    }
    const cell = readCell(spec, raw)
    if (!cell.ok) {
      if (target.target === 'name')
        out.errors.push({ column, raw, reason: cell.reason })
      else
        out.skippedCells.push({
          column,
          raw,
          reason: cellReason(spec, cell.reason),
        })
      return
    }
    const value = cell.value
    if (value === null) return
    switch (target.target) {
      case 'name':
        if (typeof value === 'string') out.name = value.trim()
        return
      case 'identity':
        if (typeof value === 'string') out.keys[target.key] = value
        return
      case 'attribute':
        out.patch[target.attributeId] = value
        return
      case 'ignore':
        return
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

/** What the identity lookup said about a row that reads. */
export type Resolved =
  | {
      verdict: 'attach'
      entityId: string
      matchedOn: { kind: CoreIdentityKey; value: string }
    }
  | { verdict: 'create' }
  | { verdict: 'refused'; reason: string }

export type RowInput = {
  rowNum: number
  read: ReadRow
  /** Identity key → normalised value, exactly what the creator compares on. */
  identity: Partial<Record<CoreIdentityKey, string>>
  /** Null when the row did not read — it was never looked up. */
  resolved: Resolved | null
}

export type PlannedRow = { rowNum: number; plan: RowPlan }

/**
 * Every row's plan. A row whose name cell does not read, or that its
 * creator would refuse (no name and no key for the resolver, no name for
 * the other two), is `no-land` — the only way a row fails; any other bad
 * cell is already a skipped cell on a row that lands. The rest are `attach` or `create` as the lookup
 * said — until two of them claim one identity key (transitively: a shares a
 * domain with b, b an email with c). Inside such a group, a row whose name
 * normalises the same as an earlier row's merges into it silently; if more
 * than one distinct name is left, those rows `collide` and wait on a
 * decision.
 */
export function planRows(
  rows: ReadonlyArray<RowInput>,
  creator: ImportCreator,
  nameColumn: number,
): Array<PlannedRow> {
  const planned: Array<PlannedRow> = rows.map((row) => {
    const base: RowPlan = {
      verdict: 'create',
      creator,
      name: row.read.name,
      patch: row.read.patch,
      identity: row.identity,
      errors: [],
      skippedCells: row.read.skippedCells,
    }
    if (row.read.errors.length > 0 || row.resolved === null)
      return {
        rowNum: row.rowNum,
        plan: { ...base, verdict: 'no-land', errors: row.read.errors },
      }
    const resolved = row.resolved
    switch (resolved.verdict) {
      case 'refused':
        return {
          rowNum: row.rowNum,
          plan: {
            ...base,
            verdict: 'no-land',
            errors: [{ column: nameColumn, raw: '', reason: resolved.reason }],
          },
        }
      case 'attach':
        return {
          rowNum: row.rowNum,
          plan: {
            ...base,
            verdict: 'attach',
            entityId: resolved.entityId,
            matchedOn: resolved.matchedOn,
          },
        }
      case 'create':
        return { rowNum: row.rowNum, plan: base }
    }
  })
  for (const group of identityGroups(planned)) markGroup(group)
  return planned
}

/**
 * The landing rows that share an identity key, transitively, in row order —
 * only groups of two or more. Union-find over `kind:value`.
 */
function identityGroups(
  planned: ReadonlyArray<PlannedRow>,
): Array<Array<PlannedRow>> {
  const parent = planned.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const holder = new Map<string, number>()
  planned.forEach((row, i) => {
    if (row.plan.verdict === 'no-land') return
    for (const [kind, value] of Object.entries(row.plan.identity)) {
      const claim = `${kind}:${value}`
      const first = holder.get(claim)
      if (first === undefined) holder.set(claim, i)
      else parent[find(i)] = find(first)
    }
  })
  const groups = new Map<number, Array<PlannedRow>>()
  planned.forEach((row, i) => {
    if (row.plan.verdict === 'no-land') return
    const root = find(i)
    groups.set(root, [...(groups.get(root) ?? []), row])
  })
  return [...groups.values()].filter((g) => g.length > 1)
}

function nameKey(name: string | null): string {
  return name === null ? '' : normalizeName(name)
}

/** Same name → merge into the first; two or more names left → collide. */
function markGroup(group: Array<PlannedRow>): void {
  const reps: Array<PlannedRow> = []
  for (const row of group) {
    const same = reps.find(
      (r) => nameKey(r.plan.name) === nameKey(row.plan.name),
    )
    if (same) {
      row.plan = { ...row.plan, verdict: 'merged', mergedInto: same.rowNum }
      continue
    }
    reps.push(row)
  }
  if (reps.length < 2) return
  for (const rep of reps) {
    rep.plan = {
      ...rep.plan,
      verdict: 'collide',
      collidesWith: reps.filter((r) => r !== rep).map((r) => r.rowNum),
    }
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** The rows of the collision `rowNum` belongs to, lowest first; empty when none. */
export function collisionMembers(
  rows: ReadonlyArray<PlannedRow>,
  rowNum: number,
): Array<number> {
  const anchor = rows.find((r) => r.rowNum === rowNum)
  const others = anchor?.plan.collidesWith
  if (!anchor || !others) return []
  return [rowNum, ...others].sort((a, b) => a - b)
}

/** What the resolver said about a row, before any collision touched it. */
function landedVerdict(plan: RowPlan): ImportVerdict {
  return plan.entityId === undefined ? 'create' : 'attach'
}

/** The plan with `mergedInto` taken off — optional means absent, never `undefined`. */
function unmerged(plan: RowPlan): RowPlan {
  const out: RowPlan = {
    verdict: plan.verdict,
    creator: plan.creator,
    name: plan.name,
    patch: plan.patch,
    identity: plan.identity,
    errors: plan.errors,
    skippedCells: plan.skippedCells,
  }
  if (plan.entityId !== undefined) out.entityId = plan.entityId
  if (plan.matchedOn !== undefined) out.matchedOn = plan.matchedOn
  if (plan.collidesWith !== undefined) out.collidesWith = plan.collidesWith
  if (plan.decision !== undefined) out.decision = plan.decision
  return out
}

/**
 * A decision on one collision, stored on every row of it. `keep-first`
 * lands the collision's first row (its name, its verdict from the lookup)
 * and folds the others into it; `keep-second` does the same with the second
 * row; `skip-both` lands none of them. A row that had merged silently into
 * one of them follows its row: folded while that row lands or folds,
 * skipped when it is skipped. Returns the rows that changed.
 */
export function applyDecision(
  rows: ReadonlyArray<PlannedRow>,
  rowNum: number,
  decision: CollisionDecision,
): Array<PlannedRow> {
  const members = collisionMembers(rows, rowNum)
  if (members.length < 2) return []
  const kept =
    decision === 'keep-first'
      ? members[0]
      : decision === 'keep-second'
        ? members[1]
        : null
  const changed: Array<PlannedRow> = []
  for (const row of rows) {
    const plan = row.plan
    if (members.includes(row.rowNum)) {
      const base: RowPlan = { ...unmerged(plan), decision }
      const next: RowPlan =
        kept === null
          ? { ...base, verdict: 'skip' }
          : row.rowNum === kept
            ? { ...base, verdict: landedVerdict(plan) }
            : { ...base, verdict: 'merged', mergedInto: kept }
      changed.push({ rowNum: row.rowNum, plan: next })
      continue
    }
    const into = plan.mergedInto
    if (into !== undefined && members.includes(into)) {
      changed.push({
        rowNum: row.rowNum,
        plan: { ...plan, verdict: kept === null ? 'skip' : 'merged' },
      })
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type PlanCounts = {
  create: number
  attach: number
  noLand: number
  collide: number
  merged: number
  skip: number
  /** Cells left out of rows that land. */
  cellsSkipped: number
  total: number
}

/** One verdict's tally — what a `group by verdict` answers. */
export type VerdictTally = {
  verdict: ImportVerdict
  rows: number
  skippedCells: number
}

const LANDS: ReadonlySet<ImportVerdict> = new Set([
  'attach',
  'create',
  'merged',
])

export function countsFrom(tallies: ReadonlyArray<VerdictTally>): PlanCounts {
  const counts: PlanCounts = {
    create: 0,
    attach: 0,
    noLand: 0,
    collide: 0,
    merged: 0,
    skip: 0,
    cellsSkipped: 0,
    total: 0,
  }
  for (const t of tallies) {
    counts.total += t.rows
    if (LANDS.has(t.verdict)) counts.cellsSkipped += t.skippedCells
    switch (t.verdict) {
      case 'create':
        counts.create += t.rows
        break
      case 'attach':
        counts.attach += t.rows
        break
      case 'no-land':
        counts.noLand += t.rows
        break
      case 'collide':
        counts.collide += t.rows
        break
      case 'merged':
        counts.merged += t.rows
        break
      case 'skip':
        counts.skip += t.rows
        break
    }
  }
  return counts
}

export function countPlans(plans: ReadonlyArray<RowPlan>): PlanCounts {
  return countsFrom(
    plans.map((p) => ({
      verdict: p.verdict,
      rows: 1,
      skippedCells: p.skippedCells.length,
    })),
  )
}

/** The rows a commit writes a record for — a merged row lands on another's. */
export function landingRows(counts: PlanCounts): number {
  return counts.create + counts.attach
}

/** A collision nobody has decided keeps the batch from committing. */
export function awaitingDecision(counts: PlanCounts): boolean {
  return counts.collide > 0
}

/** The page title: `31 create · 12 attach · 3 will not land · 2 collide.` */
export function verdictSentence(counts: PlanCounts): string {
  const parts = [`${counts.create} create`, `${counts.attach} attach`]
  if (counts.noLand > 0) parts.push(`${counts.noLand} will not land`)
  if (counts.collide > 0) parts.push(`${counts.collide} collide`)
  return `${parts.join(' · ')}.`
}

/** The column as a person reads it: its header, else its letter. */
function headerOf(column: number, headers: ReadonlyArray<string> | null) {
  const h = headers?.at(column)?.trim() ?? ''
  return h === '' ? columnLetter(column) : h
}

/**
 * The first skipped cell, named: `Raise "TBD" skipped · not money`, with a
 * count when there are more. Empty when nothing was skipped.
 */
function skippedText(
  plan: RowPlan,
  headers: ReadonlyArray<string> | null,
): string {
  const first = plan.skippedCells.at(0)
  if (!first) return ''
  const more =
    plan.skippedCells.length > 1
      ? ` · +${plan.skippedCells.length - 1} more`
      : ''
  const raw = first.raw.trim()
  const shown = raw.length > 24 ? `${raw.slice(0, 23)}…` : raw
  return `${headerOf(first.column, headers)} "${shown}" skipped · ${first.reason}${more}`
}

const KEY_LABELS: Record<CoreIdentityKey, string> = {
  domain: 'domain',
  email: 'email',
  linkedin: 'linkedin',
  cin: 'cin',
}

function firstKey(
  identity: Partial<Record<CoreIdentityKey, string>>,
): string | null {
  const entry = Object.entries(identity).at(0)
  return entry ? `${entry[0]} ${entry[1]}` : null
}

/**
 * The row's why lane — data, not policy: the key that matched, the key
 * that is new, the cell that did not read, the row it folds into. It names
 * the creator whenever that is not the resolver.
 */
export function whyOf(
  plan: RowPlan,
  headers: ReadonlyArray<string> | null,
): string {
  const skipped = skippedText(plan, headers)
  const via =
    plan.creator === 'resolveEntity' ? '' : ` · ${CREATOR_LABELS[plan.creator]}`
  switch (plan.verdict) {
    case 'no-land': {
      const e = plan.errors.at(0)
      if (!e) return 'does not read'
      const more =
        plan.errors.length > 1 ? ` · +${plan.errors.length - 1} more` : ''
      return `${columnName(e.column, headers)}: ${e.reason}${more}`
    }
    case 'attach': {
      const key = plan.matchedOn
        ? `${KEY_LABELS[plan.matchedOn.kind]} ${plan.matchedOn.value}`
        : 'matched'
      return skipped ? `${key} · ${skipped}` : key
    }
    case 'create': {
      if (skipped) return `${skipped}${via}`
      const key = firstKey(plan.identity)
      return `${key ? `new ${key}` : 'new · name only'}${via}`
    }
    case 'collide':
      return `${firstKey(plan.identity) ?? 'same key'} · also row ${(plan.collidesWith ?? []).join(', ')}`
    case 'merged':
      return `${firstKey(plan.identity) ?? 'same key'} · folds into row ${plan.mergedInto ?? ''}`
    case 'skip':
      return `${firstKey(plan.identity) ?? 'same key'} · skipped`
  }
}
