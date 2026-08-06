/**
 * Gross XIRR: the annualized rate r where NPV of dated flows is zero.
 * Newton-Raphson from a neutral guess, bisection fallback when Newton
 * diverges or leaves the domain (CONTEXT.md phase 15). Pure — no schema
 * imports; dates are ISO YYYY-MM-DD strings, day-count Actual/365.
 */

export type CashFlow = {
  date: string
  /** negative = money out (investment), positive = money in (proceeds/value) */
  amount: number
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

function years(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_YEAR
}

function npv(rate: number, flows: Array<CashFlow>, t0: string): number {
  let sum = 0
  for (const f of flows) sum += f.amount / Math.pow(1 + rate, years(t0, f.date))
  return sum
}

function npvDerivative(
  rate: number,
  flows: Array<CashFlow>,
  t0: string,
): number {
  let sum = 0
  for (const f of flows) {
    const t = years(t0, f.date)
    sum += (-t * f.amount) / Math.pow(1 + rate, t + 1)
  }
  return sum
}

/**
 * Returns the annualized rate (0.15 = 15%), or null when undefined:
 * fewer than two flows, all flows one sign, or no root in (-99.99%, 1000%].
 */
export function xirr(flows: Array<CashFlow>): number | null {
  if (flows.length < 2) return null
  const hasNegative = flows.some((f) => f.amount < 0)
  const hasPositive = flows.some((f) => f.amount > 0)
  if (!hasNegative || !hasPositive) return null

  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date))
  const t0 = sorted[0].date
  const LO = -0.9999
  const HI = 10

  // Newton-Raphson: fast when it behaves.
  let rate = 0.1
  for (let i = 0; i < 50; i++) {
    const value = npv(rate, sorted, t0)
    if (Math.abs(value) < 1e-9) return rate
    const slope = npvDerivative(rate, sorted, t0)
    if (slope === 0 || !Number.isFinite(slope)) break
    const next = rate - value / slope
    if (!Number.isFinite(next) || next <= LO || next > HI) break
    if (Math.abs(next - rate) < 1e-10) return next
    rate = next
  }

  // Bisection: guaranteed once a sign change is bracketed.
  let lo = LO
  let hi = HI
  let fLo = npv(lo, sorted, t0)
  const fHi = npv(hi, sorted, t0)
  if (fLo * fHi > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid, sorted, t0)
    if (Math.abs(fMid) < 1e-9 || hi - lo < 1e-10) return mid
    if (fLo * fMid < 0) {
      hi = mid
    } else {
      lo = mid
      fLo = fMid
    }
  }
  return (lo + hi) / 2
}
