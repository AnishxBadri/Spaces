import { fmtMoney, fmtMultiple } from '@spaces/core/portfolio/format'
import { portfolioHeadline } from '@spaces/core/portfolio/rollup'
import type {
  HeadlineFigure,
  PortfolioRollup,
} from '@spaces/core/portfolio/rollup'

/**
 * The book's headline, in the two layouts that print it: Portfolio's strip
 * above the holdings table and Today's rail. Both draw the same figures under
 * the same names from `portfolioHeadline` — the layout and whether money is
 * compact are the only things a surface decides.
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

/** Portfolio: one inline strip, money compact — the table carries the rest. */
export function PortfolioHeadlineStrip({
  rollup,
  baseCurrency,
}: {
  rollup: PortfolioRollup
  baseCurrency: string
}) {
  return (
    <>
      {portfolioHeadline(rollup).map((f) => (
        <div key={f.key} className="flex items-baseline gap-2">
          <span className="text-label text-graphite">{f.label}</span>
          <span className="tabular text-ui font-medium">
            {formatFigure(f, baseCurrency, true)}
          </span>
        </div>
      ))}
    </>
  )
}

/** Today: the rail's ruled rows, money exact. */
export function PortfolioHeadlineRail({
  rollup,
  baseCurrency,
}: {
  rollup: PortfolioRollup
  baseCurrency: string
}) {
  return (
    <>
      {portfolioHeadline(rollup).map((f) => (
        <div
          key={f.key}
          className="flex h-row items-center justify-between border-t border-rule"
        >
          <span className="field-label text-graphite">{f.label}</span>
          <span className="mono text-ui font-medium">
            {formatFigure(f, baseCurrency, false)}
          </span>
        </div>
      ))}
    </>
  )
}
