import { ReadoutStrip } from '#/components/page-header'
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
 */
export function PortfolioHeadlineStrip({
  rollup,
  baseCurrency,
}: {
  rollup: PortfolioRollup
  baseCurrency: string
}) {
  return (
    <ReadoutStrip
      cells={[
        ...portfolioHeadline(rollup).map((f) => ({
          label: f.label,
          value: formatFigure(f, baseCurrency, true),
        })),
        { label: 'XIRR', value: fmtXirr(rollup.grossXirr) },
      ]}
    />
  )
}

/** Today: the rail's caps rows — Invested, Value, MOIC — money exact. */
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
        <div key={f.key} className="flex items-baseline justify-between">
          <span className="field-label text-graphite">{f.label}</span>
          <span className="mono text-ui text-foreground">
            {formatFigure(f, baseCurrency, false)}
          </span>
        </div>
      ))}
    </>
  )
}
