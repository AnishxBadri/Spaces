import { Link } from '@tanstack/react-router'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import type { IntegrationRow, IntegrationState } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The Installed ledger: one 40px row per plugin — the operator's switch,
 * name and version, what it last did or why it is not running, today's
 * credits, the last run, the state, and the one action the state calls for.
 * The three ways of not running read apart:
 * - degraded — amber row, the worker's reason, Fix;
 * - tripped — rose row, the breaker's reason, Reset;
 * - off — the switch off and the row in graphite, nothing wrong.
 * A missing key is `not yet`: no tint, Add key. A newer version in the
 * registry shows beside the version, and a running row offers Update.
 */

/** The word in the status lane. */
export const STATE_WORD: Record<IntegrationState, string> = {
  enabled: 'enabled',
  starting: 'starting',
  'needs-key': 'not yet',
  degraded: 'degraded',
  tripped: 'tripped',
  off: 'off',
}

const ROW_TINT: Partial<Record<IntegrationState, string>> = {
  degraded: 'bg-[var(--badge-amber)]',
  tripped: 'bg-[var(--badge-rose)]',
}

const MIDDLE_INK: Partial<Record<IntegrationState, string>> = {
  degraded: 'text-[var(--badge-amber-ink)]',
  tripped: 'text-destructive',
}

/** The status lane's square: pine running, crimson stopped, hollow otherwise. */
const DOT: Record<IntegrationState, string> = {
  enabled: 'bg-primary',
  starting: 'border border-graphite',
  'needs-key': 'border border-graphite',
  degraded: 'bg-destructive',
  tripped: 'bg-destructive',
  off: 'bg-rule',
}

/** The middle lane: what it last did, or why it is not doing it. */
export function middleOf(row: IntegrationRow): string {
  switch (row.state) {
    case 'needs-key':
      return 'No key yet'
    case 'degraded':
      return row.reason ?? 'the worker could not load it'
    case 'tripped':
      return `${row.reason ?? 'stopped by the breaker'} · ${row.errorCount} failed`
    default:
      return row.summary ?? ''
  }
}

/** `12 / 100 cr`, `3 cr`, or a dash when nothing was spent and nothing is capped. */
export function creditsOf(row: IntegrationRow): string {
  const { used, cap } = row.credits
  if (cap !== null) return `${used} / ${cap} cr`
  return used > 0 ? `${used} cr` : '—'
}

export type LedgerActions = {
  readonly onToggle: (row: IntegrationRow, enabled: boolean) => void
  readonly onReset: (row: IntegrationRow) => void
  readonly onUpdate: (row: IntegrationRow) => void
  /** The row whose write is in flight; its controls are disabled. */
  readonly pending: string | null
}

const LINK =
  'focus-ring rounded-md text-label text-graphite hover:text-foreground'

function ActionLane({
  row,
  actions,
}: {
  row: IntegrationRow
  actions: LedgerActions
}) {
  const to = '/settings/integrations/$integrationId'
  const params = { integrationId: row.id }
  switch (row.state) {
    case 'tripped':
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={actions.pending === row.id}
          onClick={() => actions.onReset(row)}
        >
          Reset
        </Button>
      )
    case 'degraded':
      return (
        <Link
          to={to}
          params={params}
          className={cn(LINK, 'font-medium text-primary')}
        >
          Fix
        </Link>
      )
    case 'needs-key':
      return (
        <Link
          to={to}
          params={params}
          className={cn(LINK, 'font-medium text-primary')}
        >
          Add key
        </Link>
      )
    default:
      return row.update !== null ? (
        <Button
          size="xs"
          variant="outline"
          disabled={actions.pending === row.id}
          onClick={() => actions.onUpdate(row)}
        >
          Update
        </Button>
      ) : (
        <Link to={to} params={params} className={LINK}>
          Configure
        </Link>
      )
  }
}

function LedgerLine({
  row,
  actions,
  last,
}: {
  row: IntegrationRow
  actions: LedgerActions
  last: boolean
}) {
  const off = row.state === 'off'
  return (
    <li
      data-state={row.state}
      className={cn(
        'flex h-ledger-row items-center gap-3 px-3',
        !last && 'border-b border-rule',
        ROW_TINT[row.state],
      )}
    >
      <span className="flex w-8 shrink-0">
        <Switch
          checked={row.enabled}
          disabled={actions.pending === row.id}
          aria-label={`${row.name} ${row.enabled ? 'on' : 'off'}`}
          onCheckedChange={(next) => actions.onToggle(row, next)}
        />
      </span>
      <span className="flex w-48 shrink-0 items-baseline gap-2">
        <span
          className={cn(
            'min-w-0 truncate text-body font-medium',
            off ? 'text-graphite' : 'text-foreground',
          )}
        >
          {row.name}
        </span>
        <span className="shrink-0 mono text-micro text-graphite">
          {row.version}
        </span>
        {row.update !== null ? (
          <span
            className="shrink-0 mono text-micro text-primary"
            title={`${row.update} is in the registry`}
          >
            → {row.update}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-ui',
          MIDDLE_INK[row.state] ?? 'text-graphite',
        )}
        title={middleOf(row)}
      >
        {middleOf(row)}
      </span>
      <span className="w-24 shrink-0 numeric text-micro text-graphite">
        {creditsOf(row)}
      </span>
      <span className="w-24 shrink-0 mono text-micro text-graphite">
        {row.lastRun ? `ran ${row.lastRun.ago}` : 'never ran'}
      </span>
      <span className="flex w-24 shrink-0 items-center gap-2">
        <span aria-hidden className={cn('size-1.5 shrink-0', DOT[row.state])} />
        <span
          className={cn(
            'mono text-micro',
            row.state === 'tripped'
              ? 'text-destructive'
              : row.state === 'degraded'
                ? 'text-[var(--badge-amber-ink)]'
                : row.state === 'enabled'
                  ? 'text-foreground'
                  : 'text-graphite',
          )}
        >
          {STATE_WORD[row.state]}
        </span>
      </span>
      <span className="flex w-18 shrink-0 justify-end">
        <ActionLane row={row} actions={actions} />
      </span>
    </li>
  )
}

export function IntegrationLedger({
  rows,
  actions,
}: {
  rows: ReadonlyArray<IntegrationRow>
  actions: LedgerActions
}) {
  return (
    <div className="flex flex-col pt-8">
      <SectionHead as="h3" title="Installed" count={String(rows.length)} />
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-ui text-graphite">No plugins installed.</p>
      ) : (
        <ol>
          {rows.map((row, i) => (
            <LedgerLine
              key={row.id}
              row={row}
              actions={actions}
              last={i === rows.length - 1}
            />
          ))}
        </ol>
      )}
    </div>
  )
}
