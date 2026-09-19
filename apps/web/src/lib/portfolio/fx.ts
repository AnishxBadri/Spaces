/**
 * Currency conversion against the workspace base (CONTEXT.md, 2026-08-06).
 * Original currency is truth; conversion happens at read. Lookup is the
 * latest rate ≤ the requested date. A missing rate returns null — callers
 * surface it ("N events need a rate"), never assume 1.0.
 */

export type FxRate = {
  currency: string
  date: string
  rateToBase: number
}

/** Latest rate ≤ date for a currency; 1 for the base itself. */
export function rateFor(
  rates: Array<FxRate>,
  currency: string,
  date: string,
  baseCurrency: string,
): number | null {
  if (currency === baseCurrency) return 1
  let best: FxRate | null = null
  for (const r of rates) {
    if (r.currency !== currency || r.date > date) continue
    if (best === null || r.date > best.date) best = r
  }
  return best === null ? null : best.rateToBase
}

export function convertToBase(
  amount: number,
  currency: string,
  date: string,
  rates: Array<FxRate>,
  baseCurrency: string,
): number | null {
  const rate = rateFor(rates, currency, date, baseCurrency)
  return rate === null ? null : amount * rate
}
