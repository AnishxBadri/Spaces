import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import type { StoppedPlugin } from '#/lib/server-fns'

/** What a row says when a stopped plugin left no `last_error`. */
const NO_REASON = {
  tripped: 'stopped by the breaker',
  degraded: 'the worker could not load it',
}

const reasonOf = (p: StoppedPlugin): string =>
  p.state === 'capped' ? p.reason : (p.lastError ?? NO_REASON[p.state])

const figureOf = (p: StoppedPlugin): string => {
  switch (p.state) {
    case 'tripped':
      return 'off'
    case 'degraded':
      return 'degraded'
    case 'capped':
      return `${p.refused} refused today`
  }
}

/** The section's count: how many, and what is wrong with them. */
const countOf = (stopped: ReadonlyArray<StoppedPlugin>): string => {
  const capped = stopped.filter((p) => p.state === 'capped').length
  const what =
    capped === 0
      ? 'not running'
      : capped === stopped.length
        ? 'at their credit cap'
        : 'not running or capped'
  return `${stopped.length} · ${what}`
}

/**
 * The plugin lines on Today and Review: one row per plugin that is switched
 * on and not running, or refusing work at its daily credit cap, with the
 * reason. This is where a record head's missing action, or an action that
 * did nothing, is explained (D53, D63). Renders nothing while every plugin
 * runs; a stopped line clears when its row is reset, a capped one at UTC
 * midnight.
 */
export function PluginStatusSection({
  stopped,
}: {
  stopped: ReadonlyArray<StoppedPlugin>
}) {
  if (stopped.length === 0) return null
  return (
    <LedgerSection label="Plugins" count={countOf(stopped)}>
      {stopped.map((p, i) => (
        <LedgerRow
          key={`${p.integrationId}:${p.state}`}
          last={i === stopped.length - 1}
        >
          <span className="w-65 shrink-0 truncate mono text-ui font-medium">
            {p.pluginId}
          </span>
          <span className="min-w-0 truncate mono text-micro text-graphite">
            {reasonOf(p)}
          </span>
          <span className="flex-1" />
          <LedgerFigure tone="bad">{figureOf(p)}</LedgerFigure>
        </LedgerRow>
      ))}
    </LedgerSection>
  )
}
