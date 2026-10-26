import { dayKey, formatDay } from '@spaces/core/format'
import { fmtMoney } from '@spaces/core/portfolio/format'

/**
 * How a record readout prints: the day (`4 Oct`, `4 Oct 2024` in another
 * year) with no age tail, and `—` for none. Pure, so the server and the
 * browser print the same string from the loader's `today`.
 */

export const DASH = '—'

export { daysBetween } from '@spaces/core/format'

/** The local calendar day of an instant, `YYYY-MM-DD`. */
export function localDay(d: Date): string {
  return dayKey(d)
}

/** `4 Oct`, or `4 Nov 2025` outside the current year. */
export function readoutDay(day: string | null, today: string): string {
  if (day === null) return DASH
  return formatDay(day, today)
}

/** `$4.2M @ $18M` — a round's size at its post-money; `—` for none. */
export function readoutRound(
  r: {
    raised: number | null
    postMoney: number | null
    currency: string
  } | null,
): string {
  if (r === null || (r.raised === null && r.postMoney === null)) return DASH
  const money = (n: number) => fmtMoney(n, r.currency, { compact: true })
  if (r.postMoney === null) return money(r.raised ?? 0)
  return `${r.raised === null ? DASH : money(r.raised)} @ ${money(r.postMoney)}`
}
