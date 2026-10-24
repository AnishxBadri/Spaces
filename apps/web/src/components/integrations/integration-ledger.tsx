import { Link } from '@tanstack/react-router'
import { SettingsGroupHead } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import { roleWords } from '#/lib/integrations/catalogue'
import type { IntegrationRow, IntegrationState } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The Installed ledger: one 40px row per plugin — the operator's switch,
 * its mark, name and version, the jobs it does, its state over the one
 * number that matters (credits, signals, people connected), and `Open ›`,
 * or `Update` when the registry has a newer version it can run.
 * The three ways of not running read apart:
 * - degraded — amber row, the worker's reason, Fix;
 * - tripped — rose row, the breaker's reason, Reset;
 * - off — the switch off and the row in graphite, nothing wrong.
 * A missing key or a required setting with no value is `not yet`: no tint,
 * Add key or Set up. A newer version this host cannot run says why beside
 * the jobs; after an upgrade the row says whether going back is a swap or a
 * restore.
 */

/** The word in the status lane. */
export const STATE_WORD: Record<IntegrationState, string> = {
  enabled: 'enabled',
  starting: 'starting',
  'needs-key': 'not yet',
  'needs-setup': 'not yet',
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
  'needs-setup': 'border border-graphite',
  degraded: 'bg-destructive',
  tripped: 'bg-destructive',
  off: 'bg-rule',
}

/** The middle lane: the jobs it does, or why it is not doing them. */
export function middleOf(row: IntegrationRow): string {
  switch (row.state) {
    case 'needs-key':
      return 'No key yet'
    case 'needs-setup':
      return 'Not set up yet'
    case 'degraded':
      return row.reason ?? 'the worker could not load it'
    case 'tripped':
      return `${row.reason ?? 'stopped by the breaker'} · ${row.errorCount} failed`
    default:
      return row.roles.length > 0 ? roleWords(row.roles) : (row.summary ?? '')
  }
}

/** The rollback answer as the ledger and the card word it. */
export const ROLLBACK_WORD: Record<
  NonNullable<IntegrationRow['rollback']>['answer'],
  string
> = {
  available: 'rollback available',
  unsafe: 'rollback unsafe — restore from backup',
  unknown: 'rollback not known until it loads',
}

/** The middle lane's trailing note: why no update, and the rollback answer. */
export function versionNoteOf(row: IntegrationRow): string | null {
  const parts = [
    row.held,
    row.rollback === null ? null : ROLLBACK_WORD[row.rollback.answer],
  ].filter((p): p is string => p !== null)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** A plugin's mark: its initial on a square, ink when installed, rule when offered. */
export function PluginMark({
  name,
  offered = false,
}: {
  name: string
  offered?: boolean
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center mono text-micro font-medium',
        offered ? 'bg-rule text-graphite' : 'bg-foreground text-background',
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
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
  const to = '/settings/plugins/$integrationId'
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
    case 'needs-setup':
      return (
        <Link
          to={to}
          params={params}
          className={cn(LINK, 'font-medium text-primary')}
        >
          Set up
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
          Open ›
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
  const note = versionNoteOf(row)
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
      <PluginMark name={row.name} />
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
          v{row.version}
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
      <span className="flex min-w-0 flex-1 items-baseline gap-3">
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            MIDDLE_INK[row.state] === undefined
              ? 'mono text-micro text-graphite'
              : cn('text-ui', MIDDLE_INK[row.state]),
          )}
          title={middleOf(row)}
        >
          {middleOf(row)}
        </span>
        {note !== null ? (
          <span
            className={cn(
              'shrink-0 mono text-micro',
              row.rollback?.answer === 'unsafe'
                ? 'text-[var(--badge-amber-ink)]'
                : 'text-graphite',
            )}
            title={
              row.rollback === null
                ? note
                : `Upgraded from ${row.rollback.from} · ${note}`
            }
          >
            {note}
          </span>
        ) : null}
      </span>
      <span className="flex w-36 shrink-0 flex-col justify-center">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0', DOT[row.state])}
          />
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
        <span className="truncate numeric text-micro text-graphite">
          {row.figure}
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
    <div className="flex flex-col">
      <SettingsGroupHead title="Installed" count={String(rows.length)} />
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
