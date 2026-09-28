import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  alsoCreateWhy,
  landingRows,
  referenceLands,
  verdictSentence,
  whyOf,
} from '@spaces/core/import/plan'
import { KeyHint, PageHeader, ReadoutStrip } from '#/components/page-header'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import type {
  CollisionDecision,
  ImportAlsoCreate,
  ImportVerdict,
  PlanCounts,
  RowPlan,
} from '@spaces/core/import/plan'
import type {
  ImportPreviewView,
  PreviewFilter,
  PreviewRow,
} from '#/lib/import/plan'

/**
 * The preview step (SPA-167, import-5): the dry run, drawn from the stored
 * plans. Copied, not designed — the header is `PageHeader` with the verdict
 * sentence as its title, the counts are the shipped `ReadoutStrip`, and the
 * rows keep the ledger rhythm (fixed lanes on rules, a mono lane the row ends
 * on, a square badge for the verdict). The only commentary is the head's
 * caps line and the one mono foot line; a row carries values.
 */

const BADGE: Record<ImportVerdict, { color: string; label: string }> = {
  attach: { color: 'blue', label: 'attach' },
  create: { color: 'emerald', label: 'create' },
  collide: { color: 'amber', label: 'collide' },
  'no-land': { color: 'rose', label: 'no land' },
  merged: { color: 'slate', label: 'merged' },
  skip: { color: 'slate', label: 'skip' },
}

// ---------------------------------------------------------------------------
// Header + strip
// ---------------------------------------------------------------------------

export function PreviewHeader({
  counts,
  filename,
  onBack,
  backing,
}: {
  counts: PlanCounts
  filename: string
  onBack: () => void
  backing: boolean
}) {
  const landing = landingRows(counts)
  return (
    <PageHeader
      eyebrow="Import · Records"
      title={verdictSentence(counts)}
      description={
        <span className="tabular">
          {filename} · {counts.total.toLocaleString('en-US')} rows · nothing
          written yet
        </span>
      }
      action={
        <>
          <Button variant="outline" pending={backing} onClick={onBack}>
            Back to mapping
          </Button>
          {/* The commit is SPA-169's; the button is drawn, not armed. */}
          <Button disabled>
            Commit {landing.toLocaleString('en-US')} rows <KeyHint>⌘↵</KeyHint>
          </Button>
        </>
      }
    />
  )
}

export function PreviewStrip({
  counts,
  batchId,
}: {
  counts: PlanCounts
  batchId: string
}) {
  const to = `/import/${batchId}`
  return (
    <ReadoutStrip
      className="border-t border-t-hairline border-b-rule"
      cells={[
        {
          label: 'Create',
          value: counts.create,
          to,
          search: { show: 'create' },
        },
        {
          label: 'Attach',
          value: counts.attach,
          to,
          search: { show: 'attach' },
        },
        {
          label: 'Will not land',
          value: counts.noLand,
          tone: 'bad',
          to,
          search: { show: 'noland' },
        },
        {
          label: 'Collide',
          value: counts.collide,
          tone: 'warn',
          to,
          search: { show: 'decide' },
        },
        { label: 'Cells skipped', value: counts.cellsSkipped },
      ]}
    />
  )
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * What the row writes: the record its reference found (`→ Ohmium`), else
 * the count of attributes plus identity keys.
 */
export function whatLands(plan: RowPlan): string {
  if (plan.verdict !== 'attach' && plan.verdict !== 'create') return ''
  const reference = referenceLands(plan)
  if (reference !== '') return reference
  const n = Object.keys(plan.patch).length + Object.keys(plan.identity).length
  return `${n} value${n === 1 ? '' : 's'}`
}

function RecordLane({
  view,
  plan,
}: {
  view: ImportPreviewView
  plan: RowPlan
}): ReactNode {
  const id = plan.entityId
  if (id === undefined) return null
  const name = view.matched[id] ?? id.slice(0, 8)
  const cls = 'focus-ring text-foreground hover:underline'
  if (view.object.kind === 'company')
    return (
      <Link
        to="/companies/$companyId"
        params={{ companyId: id }}
        className={cls}
      >
        {name}
      </Link>
    )
  if (view.object.kind === 'person')
    return (
      <Link to="/people/$personId" params={{ personId: id }} className={cls}>
        {name}
      </Link>
    )
  return name
}

function DecisionLane({
  view,
  plan,
}: {
  view: ImportPreviewView
  plan: RowPlan
}): ReactNode {
  switch (plan.verdict) {
    case 'attach':
      return <RecordLane view={view} plan={plan} />
    case 'create':
      return null
    case 'no-land':
      return 'fix in the sheet, re-upload'
    case 'collide':
      return 'needs a decision'
    case 'merged':
      return `into row ${plan.mergedInto ?? ''}`
    case 'skip':
      return 'skipped'
  }
}

const HEAD = ['Row', 'Name', 'Verdict', 'Why', 'What lands', 'Decision']

function LedgerLanes({
  view,
  row,
}: {
  view: ImportPreviewView
  row: PreviewRow
}) {
  const plan = row.plan
  const badge = BADGE[plan.verdict]
  return (
    <>
      <span className="tabular w-9 shrink-0 text-right mono text-micro text-graphite">
        {row.rowNum}
      </span>
      <span className="w-50 shrink-0 truncate text-ui" title={plan.name ?? ''}>
        {plan.name ?? <span className="text-graphite">—</span>}
      </span>
      <span className="flex w-22 shrink-0">
        <Badge option={{ color: badge.color }} index={0}>
          {badge.label}
        </Badge>
      </span>
      <span
        className="min-w-0 flex-1 truncate text-ui text-graphite"
        title={whyOf(plan, view.header)}
      >
        {whyOf(plan, view.header)}
      </span>
      <span
        className="w-32 shrink-0 truncate text-right mono text-micro text-graphite"
        title={whatLands(plan)}
      >
        {whatLands(plan)}
      </span>
      <span
        className={cn(
          'w-56 shrink-0 truncate text-right mono text-micro',
          plan.verdict === 'no-land' ? 'text-destructive' : 'text-graphite',
        )}
      >
        <DecisionLane view={view} plan={plan} />
      </span>
    </>
  )
}

/**
 * A secondary create (SPA-168): the record a create-missing reference makes,
 * drawn under the row that carries it, on the same lanes.
 */
function AlsoRow({
  view,
  carrier,
  entry,
}: {
  view: ImportPreviewView
  carrier: number
  entry: ImportAlsoCreate
}) {
  const badge = BADGE.create
  const why = alsoCreateWhy(carrier, entry, view.header)
  const name = entry.plan.name ?? Object.values(entry.plan.identity).at(0)
  const n = Object.keys(entry.plan.identity).length
  return (
    <li className="flex h-10 items-center gap-3 border-b border-rule px-2">
      <span
        aria-hidden
        className="w-9 shrink-0 text-right mono text-micro text-graphite"
      >
        +
      </span>
      <span className="w-50 shrink-0 truncate text-ui" title={name ?? ''}>
        {name ?? <span className="text-graphite">—</span>}
      </span>
      <span className="flex w-22 shrink-0">
        <Badge option={{ color: badge.color }} index={0}>
          {badge.label}
        </Badge>
      </span>
      <span
        className="min-w-0 flex-1 truncate text-ui text-graphite"
        title={why}
      >
        {why}
      </span>
      <span className="w-32 shrink-0 truncate text-right mono text-micro text-graphite">
        {n > 0 ? `${n} value${n === 1 ? '' : 's'}` : ''}
      </span>
      <span className="w-56 shrink-0" />
    </li>
  )
}

function Row({ view, row }: { view: ImportPreviewView; row: PreviewRow }) {
  return (
    <li
      className={cn(
        'flex h-10 items-center gap-3 border-b border-rule px-2',
        row.plan.verdict === 'no-land' && 'bg-[var(--badge-rose)]',
      )}
    >
      <LedgerLanes view={view} row={row} />
    </li>
  )
}

const DECISIONS: Array<CollisionDecision> = [
  'keep-first',
  'keep-second',
  'skip-both',
]

function decisionLabel(
  decision: CollisionDecision,
  first: number,
  second: number,
): string {
  switch (decision) {
    case 'keep-first':
      return `Merge into one · keep row ${first}'s name`
    case 'keep-second':
      return `Keep row ${second} instead`
    case 'skip-both':
      return 'Skip both'
  }
}

/**
 * A collision: its rows in one bone block on a warning rule, and the three
 * decisions under them. The one already taken is pressed.
 */
function CollisionBlock({
  view,
  rows,
  disabled,
  onDecide,
}: {
  view: ImportPreviewView
  rows: Array<PreviewRow>
  disabled: boolean
  onDecide: (rowNum: number, decision: CollisionDecision) => void
}) {
  const first = rows[0]
  const second = rows.at(1)
  if (!second) return <Row view={view} row={first} />
  const taken = first.plan.decision
  return (
    <li className="border-b border-rule py-2">
      <div className="border border-warning bg-bone">
        <ol>
          {rows.map((row) => (
            <li
              key={row.rowNum}
              className="flex h-10 items-center gap-3 border-b border-rule px-2"
            >
              <LedgerLanes view={view} row={row} />
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2 px-2 py-2">
          {DECISIONS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === 'keep-first' ? 'default' : 'outline'}
              aria-pressed={taken === d}
              disabled={disabled}
              onClick={() => onDecide(first.rowNum, d)}
              className={cn(
                d === 'keep-first' &&
                  'bg-foreground text-background hover:bg-foreground/85',
                d !== 'keep-first' && taken === d && 'bg-selected',
              )}
            >
              {taken === d ? (
                <Check className="size-3" strokeWidth={2} aria-hidden />
              ) : null}
              {decisionLabel(d, first.rowNum, second.rowNum)}
            </Button>
          ))}
        </div>
      </div>
    </li>
  )
}

const FILTERS: Array<{ filter: PreviewFilter; label: string }> = [
  { filter: 'all', label: 'all' },
  { filter: 'create', label: 'create' },
  { filter: 'attach', label: 'attach' },
  { filter: 'decide', label: 'needs a decision' },
  { filter: 'noland', label: 'will not land' },
]

export type LedgerItem =
  | { kind: 'row'; row: PreviewRow }
  | { kind: 'collision'; rows: Array<PreviewRow> }
  | { kind: 'also'; carrier: number; entry: ImportAlsoCreate }

/**
 * Ledger items in sheet order, a collision drawn once — as a block, where
 * its lowest drawn row falls — with every row of it, drawn or not. A row's
 * secondary creates follow it (SPA-168); under the create filter a carrier
 * that does not itself create is left out and its creates still drawn.
 */
export function ledgerItems(view: ImportPreviewView): Array<LedgerItem> {
  const byNum = new Map<number, PreviewRow>()
  for (const r of [...view.rows, ...view.collisionRows]) byNum.set(r.rowNum, r)
  const seen = new Set<number>()
  const out: Array<LedgerItem> = []
  const alsos = (rows: ReadonlyArray<PreviewRow>) => {
    for (const r of rows)
      for (const entry of r.plan.alsoCreates ?? [])
        out.push({ kind: 'also', carrier: r.rowNum, entry })
  }
  for (const row of view.rows) {
    if (seen.has(row.rowNum)) continue
    const others = row.plan.collidesWith
    if (!others) {
      if (view.filter !== 'create' || row.plan.verdict === 'create')
        out.push({ kind: 'row', row })
      alsos([row])
      continue
    }
    const members = [row.rowNum, ...others]
      .sort((a, b) => a - b)
      .flatMap((n) => {
        const r = byNum.get(n)
        return r ? [r] : []
      })
    for (const m of members) seen.add(m.rowNum)
    out.push({ kind: 'collision', rows: members })
    alsos(members)
  }
  return out
}

function itemKey(item: LedgerItem): string {
  switch (item.kind) {
    case 'row':
      return `r${item.row.rowNum}`
    case 'collision':
      return `c${item.rows[0].rowNum}`
    case 'also':
      return `a${item.carrier}:${item.entry.key}`
  }
}

export function PreviewLedger({
  view,
  batchId,
  disabled,
  onDecide,
}: {
  view: ImportPreviewView
  batchId: string
  disabled: boolean
  onDecide: (rowNum: number, decision: CollisionDecision) => void
}) {
  const more = view.matching - view.rows.length
  return (
    <section className="flex flex-col">
      <div className="flex h-8 items-center gap-3 border-b border-hairline px-2 label-caps text-graphite">
        <span className="w-9 shrink-0 text-right">{HEAD[0]}</span>
        <span className="w-50 shrink-0">{HEAD[1]}</span>
        <span className="w-22 shrink-0">{HEAD[2]}</span>
        <span className="min-w-0 flex-1">{HEAD[3]}</span>
        <span className="w-32 shrink-0 text-right">{HEAD[4]}</span>
        <span className="w-56 shrink-0 text-right">{HEAD[5]}</span>
      </div>
      <ol aria-label="Preview rows">
        {ledgerItems(view).map((item) =>
          item.kind === 'row' ? (
            <Row key={itemKey(item)} view={view} row={item.row} />
          ) : item.kind === 'also' ? (
            <AlsoRow
              key={itemKey(item)}
              view={view}
              carrier={item.carrier}
              entry={item.entry}
            />
          ) : (
            <CollisionBlock
              key={itemKey(item)}
              view={view}
              rows={item.rows}
              disabled={disabled}
              onDecide={onDecide}
            />
          ),
        )}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 mono text-micro text-graphite">
        <span className="flex flex-wrap items-center gap-x-1.5">
          {more > 0 ? (
            <span className="tabular">
              + {more.toLocaleString('en-US')} more rows ·
            </span>
          ) : null}
          <span>filter:</span>
          {FILTERS.map((f, i) => (
            <span key={f.filter} className="flex items-center gap-x-1.5">
              <Link
                to="/import/$batchId"
                params={{ batchId }}
                search={{ show: f.filter }}
                aria-current={view.filter === f.filter ? 'page' : undefined}
                className={cn(
                  'focus-ring hover:text-foreground',
                  view.filter === f.filter && 'text-foreground underline',
                )}
              >
                {f.label}
              </Link>
              {i < FILTERS.length - 1 ? <span>·</span> : null}
            </span>
          ))}
        </span>
        <span>one batch · a re-run writes nothing</span>
      </div>
    </section>
  )
}
