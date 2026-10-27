import { ReadoutStrip } from '#/components/record/record-parts'
import { fmtMoney, fmtMultiple, fmtXirr } from '@spaces/core/portfolio/format'
import {
  portfolioHeadline,
  portfolioRailHeadline,
} from '@spaces/core/portfolio/rollup'
import type {
  HeadlineFigure,
  PortfolioRollup,
} from '@spaces/core/portfolio/rollup'

/**
 * The book's headline, in the two layouts that print it: Portfolio's strip
 * above the holdings table and Today's rail. Both draw core's figures under
 * core's names — `portfolioHeadline`, and `portfolioRailHeadline` for the
 * narrow rail — so the layout and whether money is compact are the only
 * things a surface decides.
 */

function formatFigure(
  f: HeadlineFigure,
  baseCurrency: string,
  compact: boolean,
): string {
  return f.kind === 'multiple'
    ? fmtMultiple(f.amount)
    : fmtMoney(f.amount, baseCurrency, { compact })
}

/**
 * Portfolio: the head's readout strip, money compact — the table carries the
 * rest. The book's gross XIRR closes it; Today's rail does not print it.
 * - Only a figure with a value prints: a zero or a missing one is not a
 *   readout, and with none left there is no strip.
 */
export function PortfolioHeadlineStrip({
  rollup,
  baseCurrency,
}: {
  rollup: PortfolioRollup
  baseCurrency: string
}) {
  const readouts = [
    ...portfolioHeadline(rollup)
      .filter((f) => f.amount !== null && f.amount !== 0)
      .map((f) => ({
        label: f.label,
        value: formatFigure(f, baseCurrency, true),
      })),
    ...(rollup.grossXirr === null
      ? []
      : [{ label: 'XIRR', value: fmtXirr(rollup.grossXirr) }]),
  ]
  if (readouts.length === 0) return null
  return (
    <ReadoutStrip
      className="border-t-0 border-b border-hairline px-8"
      readouts={readouts}
    />
  )
}

/** Today: the rail's 32px rows — Invested, Value, MOIC — money exact. */
export function PortfolioHeadlineRail({
  rollup,
  baseCurrency,
}: {
  rollup: PortfolioRollup
  baseCurrency: string
}) {
  return (
    <>
      {portfolioRailHeadline(rollup).map((f) => (
        <div
          key={f.key}
          className="flex h-8 items-center justify-between gap-3 border-b border-rule"
        >
          <span className="text-label text-graphite">{f.label}</span>
          <span className="mono text-ui text-foreground">
            {formatFigure(f, baseCurrency, false)}
          </span>
        </div>
      ))}
    </>
  )
}
