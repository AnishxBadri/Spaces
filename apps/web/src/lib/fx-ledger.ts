import { formatDay } from '@spaces/core/format'

/**
 * The FX ledger's rows, as Currency & FX prints them.
 * - A currency's newest rate is live and covers events from its date on.
 * - An older rate covers its own date up to the day before the next newer
 *   rate; the row prints that range, never a sentence shared by every row.
 * - Live rows first, by currency; then the superseded, newest first.
 */

export type FxRate = { currency: string; date: string; rateToBase: number }

export type FxLedgerRow = FxRate & { live: boolean; appliesTo: string }

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function fxLedgerRows(
  rates: ReadonlyArray<FxRate>,
  today: string,
): Array<FxLedgerRow> {
  const monthDay = (iso: string) => formatDay(iso, today)
  const byCurrency = new Map<string, Array<FxRate>>()
  for (const r of rates) {
    const list = byCurrency.get(r.currency) ?? []
    list.push(r)
    byCurrency.set(r.currency, list)
  }
  const live: Array<FxLedgerRow> = []
  const superseded: Array<FxLedgerRow> = []
  for (const currency of [...byCurrency.keys()].sort()) {
    const list = [...(byCurrency.get(currency) ?? [])].sort((a, b) =>
      b.date.localeCompare(a.date),
    )
    list.forEach((r, i) => {
      const newer = i === 0 ? undefined : list.at(i - 1)
      if (newer === undefined) {
        live.push({
          ...r,
          live: true,
          appliesTo: `events from ${monthDay(r.date)}`,
        })
        return
      }
      const last = dayBefore(newer.date)
      superseded.push({
        ...r,
        live: false,
        appliesTo:
          last === r.date
            ? `events on ${monthDay(r.date)}`
            : `events ${monthDay(r.date)} to ${monthDay(last)}`,
      })
    })
  }
  return [...live, ...superseded]
}

/** A rate to four places at least, never rounding away a smaller one. */
export function fmtRate(rate: number): string {
  const text = String(rate)
  if (text.includes('e')) return text
  const places = text.split('.').at(1)?.length ?? 0
  return rate.toFixed(Math.max(4, places))
}
