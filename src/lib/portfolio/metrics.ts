import type { FxRate } from './fx'
import { rateFor } from './fx'
import type { CashFlow } from './xirr'
import { xirr } from './xirr'

/**
 * Derived metric kit (CONTEXT.md phase 15): cost basis, realized,
 * unrealized, MOIC/TVPI/RVPI/DPI, gross XIRR — computed live from events,
 * always as-of capable. Conversion convention (2026-08-06): cash flows at
 * transaction-date rates, unrealized value at the as-of-date rate — FX
 * gain/loss lands inside base-currency performance. A holding whose events
 * share one currency computes natively in it, needing no rates.
 */

export type MetricInvestment = {
  date: string
  amount: number
  currency: string
}
export type MetricMark = { date: string; fairValue: number; currency: string }
export type MetricDistribution = {
  date: string
  amount: number
  currency: string
  kind: 'exit' | 'secondary' | 'dividend' | 'writeoff'
}

export type HoldingEvents = {
  investments: Array<MetricInvestment>
  marks: Array<MetricMark>
  distributions: Array<MetricDistribution>
}

export type HoldingMetrics = {
  /** currency the numbers are denominated in (base, or the single native one) */
  currency: string
  costBasis: number
  realized: number
  /** latest mark ≤ asOf; falls back to cost basis when never marked */
  unrealized: number
  lastMarkDate: string | null
  writtenOff: boolean
  moic: number | null
  tvpi: number | null
  rvpi: number | null
  dpi: number | null
  /** annualized, e.g. 0.15 = 15% */
  grossXirr: number | null
}

export type MetricsResult =
  | { ok: true; metrics: HoldingMetrics }
  | { ok: false; missingRates: Array<{ currency: string; date: string }> }

type Ctx = {
  baseCurrency: string
  fxRates: Array<FxRate>
  asOf: string
  single: string | null
  missing: Array<{ currency: string; date: string }>
}

/** Native amount when single-currency, else base at the given date's rate. */
function toReporting(
  amount: number,
  currency: string,
  date: string,
  ctx: Ctx,
): number {
  if (ctx.single !== null) return amount
  const rate = rateFor(ctx.fxRates, currency, date, ctx.baseCurrency)
  if (rate === null) {
    ctx.missing.push({ currency, date })
    return 0
  }
  return amount * rate
}

export function holdingMetrics(
  events: HoldingEvents,
  opts: {
    baseCurrency: string
    fxRates?: Array<FxRate>
    /** ISO date; defaults to including everything */
    asOf?: string
    /**
     * 'base' disables the single-currency native shortcut so results are
     * always in base currency — required when rolling holdings up.
     */
    reportIn?: 'native' | 'base'
  },
): MetricsResult {
  const asOf = opts.asOf ?? '9999-12-31'
  const investments = events.investments.filter((e) => e.date <= asOf)
  const marks = events.marks.filter((e) => e.date <= asOf)
  const distributions = events.distributions.filter((e) => e.date <= asOf)

  const currencies = new Set([
    ...investments.map((e) => e.currency),
    ...marks.map((e) => e.currency),
    ...distributions.map((e) => e.currency),
  ])
  const single =
    opts.reportIn === 'base' || currencies.size !== 1
      ? null
      : [...currencies][0]

  const ctx: Ctx = {
    baseCurrency: opts.baseCurrency,
    fxRates: opts.fxRates ?? [],
    asOf,
    single,
    missing: [],
  }

  const costBasis = investments.reduce(
    (sum, e) => sum + toReporting(e.amount, e.currency, e.date, ctx),
    0,
  )
  const realized = distributions.reduce(
    (sum, e) => sum + toReporting(e.amount, e.currency, e.date, ctx),
    0,
  )

  const lastMark =
    marks.length > 0 ? marks.reduce((a, b) => (b.date >= a.date ? b : a)) : null
  const writtenOff = distributions.some((d) => d.kind === 'writeoff')
  // Marks convert at the as-of rate (current value in today's money), not
  // the mark date's. A write-off zeroes residual value even if nobody
  // entered a final 0 mark.
  const unrealized = writtenOff
    ? 0
    : lastMark !== null
      ? toReporting(
          lastMark.fairValue,
          lastMark.currency,
          asOf === '9999-12-31' ? lastMark.date : asOf,
          ctx,
        )
      : costBasis

  if (ctx.missing.length > 0) {
    return { ok: false, missingRates: ctx.missing }
  }

  const flows: Array<CashFlow> = [
    ...investments.map((e) => ({
      date: e.date,
      amount: -toReporting(e.amount, e.currency, e.date, ctx),
    })),
    ...distributions.map((e) => ({
      date: e.date,
      amount: toReporting(e.amount, e.currency, e.date, ctx),
    })),
  ]
  if (unrealized > 0) {
    const terminalDate =
      asOf !== '9999-12-31'
        ? asOf
        : [...investments, ...marks, ...distributions]
            .map((e) => e.date)
            .reduce((a, b) => (b > a ? b : a), '0000-01-01')
    flows.push({ date: terminalDate, amount: unrealized })
  }

  const ratio = (n: number) => (costBasis > 0 ? n / costBasis : null)
  // Total loss has no root for the NPV solver — the rate is -100% by
  // definition, not undefined.
  const totalLoss = costBasis > 0 && realized + unrealized === 0
  return {
    ok: true,
    metrics: {
      currency: single ?? opts.baseCurrency,
      costBasis,
      realized,
      unrealized,
      lastMarkDate: lastMark?.date ?? null,
      writtenOff,
      moic: ratio(realized + unrealized),
      tvpi: ratio(realized + unrealized),
      rvpi: ratio(unrealized),
      dpi: ratio(realized),
      grossXirr: totalLoss ? -1 : xirr(flows),
    },
  }
}
