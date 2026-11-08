/**
 * Instrument-aware ownership (YC mechanics):
 * - priced shares ÷ fully-diluted outstanding → an actual %, recomputed per
 *   round — an ownership *history* with dilution deltas, not a cap table.
 * - post-money SAFEs lock ownership at signing: amount ÷ cap, displayed as
 *   *implied %*.
 * - pre-money SAFEs and CCDs are cost-basis-only until conversion — a % is
 *   never faked.
 *
 * Corrections are appends: the caller passes originals only, each
 * stamped with `reversedAt`, and a voided check drops out of the history
 * once the as-of day has reached the void. The `shares > 0` filter below is
 * *not* what excludes a compensating row — see `liveAt`.
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

export type OwnershipRound = {
  date: string
  kind: string
  /** fully diluted, post-round */
  sharesOutstanding?: number | null
}

export type OwnershipPoint = {
  date: string
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
 * shares we hold as of that round's date over that count. Rounds without a
 * count don't produce a point (staleness stays visible, nothing is faked).
 */
export function ownership(
  investments: Array<OwnershipInvestment>,
  rounds: Array<OwnershipRound>,
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
      const ourShares = withShares
        .filter((i) => i.date <= r.date)
        .reduce((sum, i) => sum + (i.shares ?? 0), 0)
      if (ourShares === 0) continue
      const outstanding = r.sharesOutstanding ?? 0
      history.push({
        date: r.date,
        roundKind: r.kind,
        ourShares,
        sharesOutstanding: outstanding,
        pct: ourShares / outstanding,
      })
    }
    if (history.length > 0) {
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
