import type { FxRate } from './fx'
import { holdingMetrics } from './metrics'
import type { HoldingEvents, MetricsResult } from './metrics'

/**
 * The portfolio roll-up and its headline — the one computation every surface
 * that states "what the book is worth" reads (Portfolio's strip, Today's
 * rail). It lives here, pure, so a surface cannot re-derive a figure of its
 * own: Today used to add `unrealized + realized` in the route and print it as
 * "Value" beside Portfolio's "Current value", and the two read $7.0M and
 * $5.9M off the same book (2026-09-30). Both were the same roll-up; one had
 * quietly folded the cash already returned into the value still held.
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
  /** holding ids left out of the sums because a rate is missing */
  excludedForMissingRates: Array<string>
}

export type RollupHolding = {
  id: string
  /** originals only, each stamped with `reversedAt` (the D12 reader contract) */
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
  }
  const totalValue = totals.realized + totals.unrealized
  return {
    ...totals,
    moic: totals.costBasis > 0 ? totalValue / totals.costBasis : null,
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
