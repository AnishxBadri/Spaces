import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { KeyHint, PageHeader, ReadoutStrip } from '#/components/page-header'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { missingRateLine } from '@spaces/core/import/ledger-commit'
import type { CommitCounts } from '@spaces/core/import/commit'
import type { ImportVerdict } from '@spaces/core/import/plan'
import type {
  ImportReceiptView,
  ReceiptFilter,
  ReceiptRow,
} from '#/lib/import/commit'
import type {
  LedgerReceipt,
  LedgerReceiptCounts,
} from '#/lib/import/ledger-commit'

/**
 * The commit step (SPA-169, import-7): the batch page is the receipt. A
 * ledger of a stream, copied from the preview it follows — the same header,
 * the same strip anatomy, the same 40px rows on rules — with one lane added
 * that each row gains as the job passes it: the outcome, in mono, linking to
 * the record it wrote. Never a spinner: the strip's REMAINING counts down
 * and the rows fill.
 *
 * A ledger batch (SPA-171) draws the same page: its strip reads what landed
 * — HOLDINGS · INVESTMENTS · ROUNDS · MARKS · FAILED · REMAINING — and a
 * row's outcome is the events it appended, linking to the holding.
 */

const BADGE: Record<ImportVerdict, { color: string; label: string }> = {
  attach: { color: 'blue', label: 'attach' },
  create: { color: 'emerald', label: 'create' },
  collide: { color: 'amber', label: 'collide' },
  'no-land': { color: 'rose', label: 'no land' },
  merged: { color: 'slate', label: 'merged' },
  skip: { color: 'slate', label: 'skip' },
}

/** The page title: `46 written · 0 attached · 1 failed.`, or where a run is. */
export function receiptSentence(
  counts: CommitCounts,
  running: boolean,
): string {
  const parts = [
    `${counts.written.toLocaleString('en-US')} written`,
    `${counts.attached.toLocaleString('en-US')} attached`,
  ]
  if (counts.failed > 0)
    parts.push(`${counts.failed.toLocaleString('en-US')} failed`)
  if (running && counts.remaining > 0)
    parts.push(`${counts.remaining.toLocaleString('en-US')} to go`)
  return `${parts.join(' · ')}.`
}

const plural = (n: number, one: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`

/**
 * A ledger receipt's title (SPA-171): `10 holdings · 11 investments · 8
 * rounds · 7 marks · 1 failed.` — what landed, then where a run is.
 */
export function ledgerReceiptSentence(
  ledger: LedgerReceiptCounts,
  counts: CommitCounts,
  running: boolean,
): string {
  const parts = [
    plural(ledger.holdings, 'holding'),
    plural(ledger.investments, 'investment'),
    plural(ledger.rounds, 'round'),
    plural(ledger.marks, 'mark'),
  ]
  if (ledger.distributions > 0)
    parts.push(plural(ledger.distributions, 'distribution'))
  if (counts.failed > 0)
    parts.push(`${counts.failed.toLocaleString('en-US')} failed`)
  if (running && counts.remaining > 0)
    parts.push(`${counts.remaining.toLocaleString('en-US')} to go`)
  return `${parts.join(' · ')}.`
}

function seconds(ms: number): string {
  return ms < 10_000
    ? `${(ms / 1000).toFixed(1)} s`
    : `${Math.round(ms / 1000)} s`
}

export function ReceiptHeader({
  view,
  filename,
  onCommit,
  onRetry,
  pending,
}: {
  view: ImportReceiptView
  filename: string
  /** Commit again — a committed batch writes nothing, and says so. */
  onCommit: () => void
  onRetry: () => void
  pending: 'commit' | 'retry' | null
}) {
  const last = view.lastRun
  const idle = !view.running
  return (
    <PageHeader
      eyebrow={view.ledger ? 'Import · Ledger' : 'Import · Records'}
      title={
        view.ledger
          ? ledgerReceiptSentence(view.ledger.counts, view.counts, view.running)
          : receiptSentence(view.counts, view.running)
      }
      description={
        <span className="tabular">
          {filename}
          {view.running
            ? ' · committing'
            : last?.line
              ? ` · last run ${last.line}${last.durationMs !== null ? ` · ${seconds(last.durationMs)}` : ''}`
              : ''}
        </span>
      }
      action={
        <>
          {view.counts.failed > 0 ? (
            <Button
              variant="outline"
              disabled={!idle}
              pending={pending === 'retry'}
              onClick={onRetry}
            >
              Retry failed rows
            </Button>
          ) : null}
          <Button
            disabled={!idle || pending !== null}
            pending={pending === 'commit'}
            onClick={onCommit}
          >
            Commit again <KeyHint>⌘↵</KeyHint>
          </Button>
        </>
      }
    />
  )
}

export function ReceiptStrip({
  counts,
  batchId,
  ledger = null,
}: {
  counts: CommitCounts
  batchId: string
  /** A ledger batch's strip reads what landed (SPA-171). */
  ledger?: LedgerReceiptCounts | null
}) {
  const failed = {
    label: 'Failed',
    value: counts.failed,
    tone: 'bad' as const,
    to: `/import/${batchId}`,
    search: { outcome: 'failed' },
  }
  const remaining = { label: 'Remaining', value: counts.remaining }
  return (
    <ReadoutStrip
      className="border-t border-t-hairline border-b-rule"
      cells={
        ledger
          ? [
              { label: 'Holdings', value: ledger.holdings },
              { label: 'Investments', value: ledger.investments },
              { label: 'Rounds', value: ledger.rounds },
              { label: 'Marks', value: ledger.marks },
              ...(ledger.distributions > 0
                ? [{ label: 'Distributions', value: ledger.distributions }]
                : []),
              failed,
              remaining,
            ]
          : [
              { label: 'Written', value: counts.written },
              { label: 'Attached', value: counts.attached },
              failed,
              remaining,
            ]
      }
    />
  )
}

/**
 * The ledger receipt's commentary (SPA-171), one mono line per section: the
 * FX rates the committed events still need, linked where `/today` links, and
 * what a batch void reaches — never a round.
 */
export function MissingRateLine({ ledger }: { ledger: LedgerReceipt }) {
  if (ledger.missingRates.length === 0) return null
  return (
    <p className="flex flex-wrap items-center gap-x-2 px-8 mono text-micro text-warning">
      <span className="tabular">{missingRateLine(ledger.missingRates)}</span>
      <Link
        to="/settings/currency"
        className="focus-ring text-primary hover:underline"
      >
        add FX rate ›
      </Link>
    </p>
  )
}

export function VoidLine({
  ledger,
  onVoid,
  voiding,
}: {
  ledger: LedgerReceipt
  onVoid: () => void
  voiding: boolean
}) {
  if (ledger.voidLine === null) return null
  return (
    <p className="flex flex-wrap items-center gap-x-2 pb-2 mono text-micro text-graphite">
      <span className="tabular">{ledger.voidLine}</span>
      {ledger.voidable ? (
        <button
          type="button"
          disabled={voiding}
          onClick={onVoid}
          className="focus-ring text-destructive hover:underline disabled:opacity-50"
        >
          void batch ›
        </button>
      ) : null}
    </p>
  )
}

/** The outcome lane: what the job did with the row, linking what it wrote. */
export function OutcomeLane({ row }: { row: ReceiptRow }): ReactNode {
  const o = row.outcome
  const link = (label: string) => {
    const href = row.record?.href ?? null
    if (href === null) return label
    return (
      <Link
        to={href}
        title={row.record?.name}
        className="focus-ring text-foreground hover:underline"
      >
        {label}
      </Link>
    )
  }
  switch (o.kind) {
    case 'created':
      return link('created ›')
    case 'attached':
      return link('attached ›')
    case 'appended':
      return link(`${o.parts.join(' · ')} ›`)
    case 'folded':
      return o.entityId === null
        ? `into row ${o.into}`
        : link(`into row ${o.into} ›`)
    case 'failed':
      return <span className="text-destructive">failed · {o.reason}</span>
    case 'skipped':
      return `skipped · ${o.reason}`
    case 'pending':
      return '—'
  }
}

const HEAD = ['Row', 'Name', 'Verdict', 'Record', 'Outcome']

function Row({ row }: { row: ReceiptRow }) {
  const badge = BADGE[row.verdict]
  return (
    <li
      className={cn(
        'flex h-10 items-center gap-3 border-b border-rule px-2',
        row.outcome.kind === 'failed' && 'bg-[var(--badge-rose)]',
      )}
    >
      <span className="tabular w-9 shrink-0 text-right mono text-micro text-graphite">
        {row.rowNum}
      </span>
      <span className="w-50 shrink-0 truncate text-ui" title={row.name ?? ''}>
        {row.name ?? <span className="text-graphite">—</span>}
      </span>
      <span className="flex w-22 shrink-0">
        <Badge option={{ color: badge.color }} index={0}>
          {badge.label}
        </Badge>
      </span>
      <span
        className="min-w-0 flex-1 truncate text-ui text-graphite"
        title={row.record?.name ?? ''}
      >
        {row.record?.name ?? ''}
      </span>
      <span
        className="w-72 shrink-0 truncate text-right mono text-micro text-graphite"
        title={
          row.outcome.kind === 'failed'
            ? row.outcome.reason
            : row.outcome.kind === 'appended'
              ? row.outcome.parts.join(' · ')
              : undefined
        }
      >
        <OutcomeLane row={row} />
      </span>
    </li>
  )
}

const FILTERS: Array<{ filter: ReceiptFilter; label: string }> = [
  { filter: 'all', label: 'all' },
  { filter: 'failed', label: 'failed' },
]

export function ReceiptLedger({
  view,
  batchId,
}: {
  view: ImportReceiptView
  batchId: string
}) {
  const more = view.matching - view.rows.length
  return (
    <section className="flex flex-col">
      <div className="flex h-8 items-center gap-3 border-b border-hairline px-2 label-caps text-graphite">
        <span className="w-9 shrink-0 text-right">{HEAD[0]}</span>
        <span className="w-50 shrink-0">{HEAD[1]}</span>
        <span className="w-22 shrink-0">{HEAD[2]}</span>
        <span className="min-w-0 flex-1">{HEAD[3]}</span>
        <span className="w-72 shrink-0 text-right">{HEAD[4]}</span>
      </div>
      <ol aria-label="Committed rows">
        {view.rows.map((row) => (
          <Row key={row.rowNum} row={row} />
        ))}
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
                search={{ outcome: f.filter }}
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
        <span className="tabular">
          {view.running
            ? 'live · every 1.5 s'
            : view.committedAt
              ? `committed ${view.committedAt.slice(0, 10)}`
              : 'stopped'}
        </span>
      </div>
    </section>
  )
}
