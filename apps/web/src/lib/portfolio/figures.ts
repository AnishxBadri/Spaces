import { z } from 'zod'
import { formatDay } from '@spaces/core/format'
import { fmtMoney, fmtMultiple, fmtXirr } from '@spaces/core/portfolio/format'
import type { HoldingMetrics } from '@spaces/core/portfolio/metrics'

/**
 * The holding page's pure half: its search and the figures row. Client-safe —
 * nothing here reaches `db`.
 */

/**
 * `?asOf=` is the day the holding is read at: every figure and the
 * ownership ledger as they stood that day. Anything but an ISO day reads as
 * today.
 */
export const holdingSearch = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
})

export type HoldingFigure = { label: string; value: string }

/**
 * The figures row, each figure only with a value: Invested, Value (dated by
 * its mark), Realized only above 0, MOIC and XIRR once they can be computed.
 */
export function holdingFigures(
  m: Pick<
    HoldingMetrics,
    | 'currency'
    | 'costBasis'
    | 'unrealized'
    | 'realized'
    | 'lastMarkDate'
    | 'moic'
    | 'grossXirr'
  >,
  today: string,
): Array<HoldingFigure> {
  const out: Array<HoldingFigure> = []
  if (m.costBasis > 0)
    out.push({ label: 'Invested', value: fmtMoney(m.costBasis, m.currency) })
  if (m.lastMarkDate !== null)
    out.push({
      label: `Value · marked ${formatDay(m.lastMarkDate, today)}`,
      value: fmtMoney(m.unrealized, m.currency),
    })
  else if (m.unrealized > 0)
    out.push({
      label: 'Value · at cost',
      value: fmtMoney(m.unrealized, m.currency),
    })
  if (m.realized > 0)
    out.push({ label: 'Realized', value: fmtMoney(m.realized, m.currency) })
  if (m.moic !== null) out.push({ label: 'MOIC', value: fmtMultiple(m.moic) })
  if (m.grossXirr !== null)
    out.push({ label: 'XIRR', value: fmtXirr(m.grossXirr) })
  return out
}

/** A check's instrument as the ledger prints it: `SAFE`, `Priced`. */
export function instrumentLabel(instrument: string): string {
  switch (instrument) {
    case 'priced':
      return 'Priced'
    case 'safe_post_money':
      return 'SAFE'
    case 'safe_pre_money':
      return 'Pre-money SAFE'
    case 'ccd':
      return 'CCD'
    default:
      return instrument.replace(/_/g, ' ')
  }
}
