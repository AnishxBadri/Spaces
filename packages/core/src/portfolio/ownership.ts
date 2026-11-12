/**
 * Instrument-aware ownership (YC mechanics):
 * - priced shares ÷ fully-diluted outstanding → an actual %, recomputed per
 *   round — an ownership *history* with dilution deltas, not a cap table.
 * - post-money SAFEs lock ownership at signing: amount ÷ cap, displayed as
 *   *implied %*.
 * - pre-money SAFEs and CCDs are cost-basis-only until conversion — a % is
 *   never faked.
 *
 * Sales are distributions carrying `shares_sold`; they come off the count
 * at every point on or after their date.
 *
 * Corrections are appends: the caller passes originals only, each
 * stamped with `reversedAt`, and a voided check or sale drops out once the
 * as-of day has reached the void. The `shares > 0` and `sharesSold > 0`
 * filters below are *not* what exclude a compensating row — see `liveAt`.
 */
import type { Reversible } from './reversal'
import { liveAt } from './reversal'

export type Instrument = 'priced' | 'safe_post_money' | 'safe_pre_money' | 'ccd'

export type OwnershipInvestment = Reversible & {
  date: string
  amount: number
  instrument: Instrument
  shares?: number | null
  cap?: number | null
}

/**
 * A distribution as ownership reads it. One with no shares sold — a
 * dividend, a write-off — is not a sale and changes nothing.
 */
export type OwnershipSale = Reversible & {
  date: string
  sharesSold?: number | null
}

export type OwnershipRound = {
  date: string
  kind: string
  /** fully diluted, post-round */
  sharesOutstanding?: number | null
}

export type OwnershipPoint = {
  date: string
  /** The round's kind, or `SALE_POINT` for a sale after the last round. */
  roundKind: string
  ourShares: number
  sharesOutstanding: number
  pct: number
}

/**
 * Why no percentage could be had:
 * - `shares_unknown`: every check is priced and none carries its share count.
 * - `shares_outstanding_unknown`: every check is priced, but no round on or
 *   after one carries a fully-diluted count.
 * - `unconverted`: every check is a pre-money SAFE, a CCD or an uncapped
 *   post-money SAFE — none has a percentage until it converts.
 * - `mixed`: the checks are of kinds whose percentages do not add up.
 * - `no_checks`: nothing stands at the as-of day.
 */
export type CostBasisReason =
  | 'shares_unknown'
  | 'shares_outstanding_unknown'
  | 'unconverted'
  | 'mixed'
  | 'no_checks'

export type Ownership =
  | { kind: 'actual'; history: Array<OwnershipPoint>; currentPct: number }
  | { kind: 'implied'; pct: number }
  | { kind: 'cost_basis_only'; reason: CostBasisReason }

/**
 * The `roundKind` of a point a sale adds after the last counted round: it
 * sits over that round's fully-diluted count and is printed as a sale.
 */
export const SALE_POINT = 'sale'

/** A check that gives no percentage on its own until it converts. */
const unconverted = (i: OwnershipInvestment): boolean =>
  i.instrument === 'safe_pre_money' ||
  i.instrument === 'ccd' ||
  (i.instrument === 'safe_post_money' && !(i.cap != null && i.cap > 0))

function costBasisReason(
  inWindow: Array<OwnershipInvestment>,
): CostBasisReason {
  if (inWindow.length === 0) return 'no_checks'
  if (inWindow.every(unconverted)) return 'unconverted'
  if (inWindow.every((i) => i.instrument === 'priced'))
    return inWindow.some((i) => i.shares != null && i.shares > 0)
      ? 'shares_outstanding_unknown'
      : 'shares_unknown'
  return 'mixed'
}

/**
 * Ledger rule: at each round carrying a fully-diluted count, our % is the
 * shares we hold as of that round's date — bought on or before it, less sold
 * on or before it — over that count. Rounds without a count don't produce a
 * point (staleness stays visible, nothing is faked).
 * - A round before the first purchase is skipped; one after the last share
 *   is sold reads 0%. Held shares floor at 0.
 * - A sale after the last counted round adds a point on its day over that
 *   round's count, so `currentPct` reflects it.
 * - Implied and cost-basis-only results ignore sales: a SAFE has no shares.
 */
export function ownership(
  investments: Array<OwnershipInvestment>,
  rounds: Array<OwnershipRound>,
  sales: Array<OwnershipSale>,
  asOf?: string,
): Ownership {
  const inWindow = liveAt(
    asOf ? investments.filter((i) => i.date <= asOf) : investments,
    asOf,
  )
  const withShares = inWindow.filter(
    (i) => i.instrument === 'priced' && i.shares != null && i.shares > 0,
  )

  if (withShares.length > 0) {
    const sold = liveAt(
      asOf ? sales.filter((s) => s.date <= asOf) : sales,
      asOf,
    ).filter((s) => s.sharesSold != null && s.sharesSold > 0)
    const bought = (date: string): number =>
      withShares
        .filter((i) => i.date <= date)
        .reduce((sum, i) => sum + (i.shares ?? 0), 0)
    const soldBy = (date: string): number =>
      sold
        .filter((s) => s.date <= date)
        .reduce((sum, s) => sum + (s.sharesSold ?? 0), 0)
    const point = (
      date: string,
      roundKind: string,
      outstanding: number,
    ): OwnershipPoint => {
      const ourShares = Math.max(0, bought(date) - soldBy(date))
      return {
        date,
        roundKind,
        ourShares,
        sharesOutstanding: outstanding,
        pct: ourShares / outstanding,
      }
    }

    const countable = rounds
      .filter(
        (r) =>
          r.sharesOutstanding != null &&
          r.sharesOutstanding > 0 &&
          (!asOf || r.date <= asOf),
      )
      .sort((a, b) => a.date.localeCompare(b.date))
    const history: Array<OwnershipPoint> = []
    for (const r of countable) {
      if (bought(r.date) === 0) continue
      history.push(point(r.date, r.kind, r.sharesOutstanding ?? 0))
    }

    const last = history.at(-1)
    if (last !== undefined) {
      const saleDays = [
        ...new Set(sold.map((s) => s.date).filter((d) => d > last.date)),
      ].sort()
      for (const day of saleDays)
        history.push(point(day, SALE_POINT, last.sharesOutstanding))
      return {
        kind: 'actual',
        history,
        currentPct: history[history.length - 1].pct,
      }
    }
  }

  const postMoneySafes = inWindow.filter(
    (i) => i.instrument === 'safe_post_money' && i.cap != null && i.cap > 0,
  )
  if (postMoneySafes.length > 0 && postMoneySafes.length === inWindow.length) {
    const pct = postMoneySafes.reduce(
      (sum, i) => sum + i.amount / (i.cap ?? 1),
      0,
    )
    return { kind: 'implied', pct }
  }

  return { kind: 'cost_basis_only', reason: costBasisReason(inWindow) }
}
