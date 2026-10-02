import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import type { TrippedPlugin } from '#/lib/server-fns'

/**
 * Today's plugin lines: one row per plugin the breaker turned off, with the
 * reason it stopped. Renders nothing while every plugin is running, and the
 * line clears when the row is reset.
 */
export function PluginStatusSection({
  tripped,
}: {
  tripped: ReadonlyArray<TrippedPlugin>
}) {
  if (tripped.length === 0) return null
  return (
    <LedgerSection label="Plugins" count={`${tripped.length} · disabled`}>
      {tripped.map((p, i) => (
        <LedgerRow key={p.integrationId} last={i === tripped.length - 1}>
          <span className="w-65 shrink-0 truncate mono text-ui font-medium">
            {p.pluginId}
          </span>
          <span className="min-w-0 truncate mono text-micro text-graphite">
            {p.lastError ?? 'stopped by the breaker'}
          </span>
          <span className="flex-1" />
          <LedgerFigure tone="bad">off</LedgerFigure>
        </LedgerRow>
      ))}
    </LedgerSection>
  )
}
