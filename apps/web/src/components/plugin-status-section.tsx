import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import type { StoppedPlugin } from '#/lib/server-fns'

/** What a row says when the plugin left no `last_error`. */
const NO_REASON: Record<StoppedPlugin['state'], string> = {
  tripped: 'stopped by the breaker',
  degraded: 'the worker could not load it',
}

/**
 * The plugin lines on Today and Review: one row per plugin that is switched
 * on and not running, with the reason. This is where a record head's missing
 * action is explained (D63). Renders nothing while every plugin runs, and a
 * line clears when its row is reset.
 */
export function PluginStatusSection({
  stopped,
}: {
  stopped: ReadonlyArray<StoppedPlugin>
}) {
  if (stopped.length === 0) return null
  return (
    <LedgerSection label="Plugins" count={`${stopped.length} · not running`}>
      {stopped.map((p, i) => (
        <LedgerRow key={p.integrationId} last={i === stopped.length - 1}>
          <span className="w-65 shrink-0 truncate mono text-ui font-medium">
            {p.pluginId}
          </span>
          <span className="min-w-0 truncate mono text-micro text-graphite">
            {p.lastError ?? NO_REASON[p.state]}
          </span>
          <span className="flex-1" />
          <LedgerFigure tone="bad">
            {p.state === 'tripped' ? 'off' : 'degraded'}
          </LedgerFigure>
        </LedgerRow>
      ))}
    </LedgerSection>
  )
}
