import { fmtMoney } from '@spaces/core/portfolio/format'

/**
 * How a record readout prints a day: `MM-DD` in the current year, the full
 * `YYYY-MM-DD` otherwise, and `—` for none. Pure, so the server and the
 * browser print the same string from the loader's `today`.
 */

export const DASH = '—'

/** The local calendar day of an instant, `YYYY-MM-DD`. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  )
}

/** `10-04`, or `2025-11-04` outside the current year. */
export function readoutDay(day: string | null, today: string): string {
  if (day === null) return DASH
  return day.slice(0, 4) === today.slice(0, 4) ? day.slice(5) : day
}

/** `10-04 · 1d` — the day and how long ago it was. */
export function readoutDayAgo(day: string | null, today: string): string {
  if (day === null) return DASH
  return `${readoutDay(day, today)} · ${daysBetween(day, today)}d`
}

/** `10-31 · 26d` — the day and how long until it; `−3d` once it has passed. */
export function readoutDayUntil(day: string | null, today: string): string {
  if (day === null) return DASH
  const n = daysBetween(today, day)
  return `${readoutDay(day, today)} · ${n < 0 ? '−' : ''}${Math.abs(n)}d`
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
