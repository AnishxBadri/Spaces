/** Shared display formatters. One instance per format — Intl objects are
 *  expensive to construct, and three routes formatting dates three ways is how
 *  "12 Mar 2026" and "Mar 12, 2026" end up in the same table. */

const dateFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

/**
 * `Jul 30, 2026` — the one date format in tables and metadata rows.
 * Locale is pinned to `en` (not the visitor's) so a column of dates is
 * comparable down its own length; the day-first ordering an India-based fund
 * may prefer is a product decision, not a consistency one, and is unchanged
 * from what the surfaces already rendered.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return ''
  const d = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d)
}
