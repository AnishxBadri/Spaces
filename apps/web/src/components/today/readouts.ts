import type { RecordReadout } from '#/components/record/record-parts'
import { STALE_MARK_DAYS } from '#/lib/today/needs-you'
import type { ReadoutFilter } from '#/lib/today/needs-you'

/** One of Today's figures: a filter on Needs you, or a link out. */
export type TodayReadout = {
  cell: RecordReadout
  /** The Needs-you rows the figure counted, and the segment it adds after
   *  `All` (`Overdue`); absent for a link. */
  filter?: { id: ReadoutFilter; segment: string } | undefined
}

/**
 * Today's readouts: derived figures, never section counts.
 * - Only a non-zero figure shows; with every figure at zero there are none.
 * - Destructive only when the figure is bad (Overdue, a mark older than
 *   `STALE_MARK_DAYS`); every other figure is ink.
 * - Overdue, Deals past stage median and Oldest mark filter Needs you;
 *   Unfiled files links to the Files shelf it counted.
 */
export function todayReadouts({
  overdue,
  pastMedian,
  oldestMarkAge,
  unfiled,
}: {
  overdue: number
  pastMedian: number
  /** Days since the oldest live holding's last mark; null when none. */
  oldestMarkAge: number | null
  unfiled: number
}): Array<TodayReadout> {
  const out: Array<TodayReadout> = []
  if (overdue > 0)
    out.push({
      cell: { label: 'Overdue', value: `${overdue}`, tone: 'bad' },
      filter: { id: 'overdue', segment: 'Overdue' },
    })
  if (pastMedian > 0)
    out.push({
      cell: { label: 'Deals past stage median', value: `${pastMedian}` },
      filter: { id: 'pastMedian', segment: 'Past median' },
    })
  if (oldestMarkAge !== null && oldestMarkAge > 0)
    out.push({
      cell: {
        label: 'Oldest mark',
        value: `${oldestMarkAge}d`,
        ...(oldestMarkAge > STALE_MARK_DAYS ? { tone: 'bad' as const } : {}),
      },
      filter: { id: 'oldestMark', segment: 'Oldest mark' },
    })
  if (unfiled > 0)
    out.push({
      cell: {
        label: 'Unfiled files',
        value: `${unfiled}`,
        to: '/files',
        search: { filed: 'unfiled' },
      },
    })
  return out
}
