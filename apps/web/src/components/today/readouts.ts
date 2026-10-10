import type { RecordReadout } from '#/components/record/record-parts'
import { STALE_MARK_DAYS } from '#/lib/today/needs-you'

/**
 * Today's readouts: derived figures, never section counts. (D79)
 * - Each cell links to the list it counted; Unfiled carries the filter.
 * - Colour only when nonzero and bad; a zero reads graphite.
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
}): Array<RecordReadout> {
  const zero = (n: number) => (n === 0 ? { tone: 'muted' as const } : {})
  return [
    {
      label: 'Overdue',
      value: `${overdue}`,
      tone: overdue === 0 ? 'muted' : 'bad',
      to: '/tasks',
    },
    {
      label: 'Deals past stage median',
      value: `${pastMedian}`,
      tone: pastMedian === 0 ? 'muted' : 'warn',
      to: '/deals',
    },
    {
      label: 'Oldest mark',
      value: oldestMarkAge === null ? '—' : `${oldestMarkAge}d`,
      ...(oldestMarkAge !== null && oldestMarkAge > STALE_MARK_DAYS
        ? { tone: 'bad' as const }
        : {}),
      to: '/portfolio',
    },
    {
      label: 'Unfiled files',
      value: `${unfiled}`,
      ...zero(unfiled),
      to: '/files',
      search: { filed: 'unfiled' },
    },
  ]
}
