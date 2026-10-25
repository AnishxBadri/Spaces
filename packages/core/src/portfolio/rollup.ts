import type { FxRate } from './fx'
import { holdingCashFlows, holdingMetrics } from './metrics'
import type { HoldingEvents, MetricsResult } from './metrics'
import { xirr } from './xirr'
import type { CashFlow } from './xirr'

/**
 * The portfolio roll-up and its headline — the one computation every surface
 * that states "what the book is worth" reads (Portfolio's strip, Today's
 * rail). Pure and shared so no surface re-derives a figure of its own: one
 * that folds realized cash into "Value" disagrees with "Current value" off
 * the same book.
 *
 * Everything is forced to base. A holding whose events need a rate the
 * workspace does not have is excluded and named, never converted at 1.0.
 */

export type PortfolioRollup = {
  /** base-currency cost of every priced holding */
  costBasis: number
  /** cash returned — distributions, at their transaction-date rates */
  realized: number
  /** what is still held — latest mark, or cost when never marked */
  unrealized: number
  /** (realized + unrealized) / costBasis */
  moic: number | null
  /**
   * Gross XIRR of the book: every included holding's base cash flows pooled,
   * with what is still held as one flow at `asOf` (else the latest holding
   * date). -1 on a total loss, as `holdingMetrics` reads it.
   */
  grossXirr: number | null
  /** holding ids left out of the sums because a rate is missing */
  excludedForMissingRates: Array<string>
}

export type RollupHolding = {
  id: string
  /** originals only, each stamped with `reversedAt` (the reversal reader contract) */
  events: HoldingEvents
  /**
   * The holding's display metrics, when the caller already computed them —
   * reused when they are already base-denominated, recomputed in base
   * otherwise.
   */
  metrics?: MetricsResult | undefined
}

export function portfolioRollup(
  holdings: Array<RollupHolding>,
  opts: {
    baseCurrency: string
    fxRates: Array<FxRate>
    asOf?: string | undefined
  },
): PortfolioRollup {
  const totals = { costBasis: 0, realized: 0, unrealized: 0 }
  const excluded: Array<string> = []
  const cash: Array<CashFlow> = []
  let terminalDate = '0000-01-01'
  for (const h of holdings) {
    const inBase =
      h.metrics?.ok === true && h.metrics.metrics.currency === opts.baseCurrency
        ? h.metrics
        : holdingMetrics(h.events, {
            baseCurrency: opts.baseCurrency,
            fxRates: opts.fxRates,
            asOf: opts.asOf,
            reportIn: 'base',
          })
    if (!inBase.ok) {
      excluded.push(h.id)
      continue
    }
    totals.costBasis += inBase.metrics.costBasis
    totals.realized += inBase.metrics.realized
    totals.unrealized += inBase.metrics.unrealized
    const flows = holdingCashFlows(h.events, {
      baseCurrency: opts.baseCurrency,
      fxRates: opts.fxRates,
      asOf: opts.asOf,
      reportIn: 'base',
    })
    if (flows.ok) {
      cash.push(...flows.cash)
      if (flows.terminalDate > terminalDate) terminalDate = flows.terminalDate
    }
  }
  const totalValue = totals.realized + totals.unrealized
  const totalLoss = totals.costBasis > 0 && totalValue === 0
  return {
    ...totals,
    moic: totals.costBasis > 0 ? totalValue / totals.costBasis : null,
    grossXirr: totalLoss
      ? -1
      : xirr(
          totals.unrealized > 0
            ? [...cash, { date: terminalDate, amount: totals.unrealized }]
            : cash,
        ),
    excludedForMissingRates: excluded,
  }
}

export type HeadlineFigure =
  | {
      key: 'invested' | 'current' | 'realized'
      label: string
      kind: 'money'
      amount: number
    }
  | { key: 'moic'; label: string; kind: 'multiple'; amount: number | null }

/**
 * The figures a surface prints about the whole book, in order, with their
 * names. A surface chooses the layout and whether money is compact; it does
 * not choose which numbers or what they are called. "Current value" is what
 * is still held; the cash already returned is "Realized", beside it, so MOIC
 * reads as the two over "Invested".
 */
export function portfolioHeadline(
  rollup: PortfolioRollup,
): Array<HeadlineFigure> {
  return [
    {
      key: 'invested',
      label: 'Invested',
      kind: 'money',
      amount: rollup.costBasis,
    },
    {
      key: 'current',
      label: 'Current value',
      kind: 'money',
      amount: rollup.unrealized,
    },
    {
      key: 'realized',
      label: 'Realized',
      kind: 'money',
      amount: rollup.realized,
    },
    { key: 'moic', label: 'MOIC', kind: 'multiple', amount: rollup.moic },
  ]
}

/**
 * Today's rail: the headline less Realized, Current value printed "Value".
 * - Same figures as `portfolioHeadline`, by key; only the one name is short.
 * - Realized is never folded into Value; it reaches the rail through MOIC.
 */
export function portfolioRailHeadline(
  rollup: PortfolioRollup,
): Array<HeadlineFigure> {
  return portfolioHeadline(rollup).flatMap((f): Array<HeadlineFigure> => {
    if (f.key === 'realized') return []
    if (f.key === 'current') return [{ ...f, label: 'Value' }]
    return [f]
  })
}
