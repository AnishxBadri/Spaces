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

const numberFmts = new Map<number, Intl.NumberFormat>()

/**
 * A plain number with thousands grouping and a fixed number of decimals —
 * the `number.precision` display rule (spec §2: "Founded 1,987" is the bug
 * without it, so grouping is off for precision-less integers that read as
 * years). Never compact notation: that differs between Node and Chrome
 * and breaks hydration; `fmtMoney` owns compact.
 */
export function formatNumber(
  value: number | string | null | undefined,
  precision?: number,
): string {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (precision === undefined) return String(n)
  let fmt = numberFmts.get(precision)
  if (!fmt) {
    fmt = new Intl.NumberFormat('en', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
      useGrouping: true,
    })
    numberFmts.set(precision, fmt)
  }
  return fmt.format(n)
}

/**
 * How long something took — `820ms`, `4.1s`, `2m 03s`, `1h 12m`. Hand-rolled
 * for the same reason `fmtMoney` is: `Intl.RelativeTimeFormat` and compact
 * notation both differ between Node and Chrome, and a string rendered on the
 * server and again in the browser has to be the same string or hydration
 * fails. Negative input is clock skew, not a negative duration.
 */
export function formatDurationMs(ms: number): string {
  const n = Math.max(0, ms)
  if (n < 1000) return `${String(Math.round(n))}ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
  const seconds = Math.round(n / 1000)
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    return `${String(m)}m ${String(seconds % 60).padStart(2, '0')}s`
  }
  const minutes = Math.round(seconds / 60)
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * How long ago something happened, as a bare magnitude the caller suffixes —
 * `4s`, `2m`, `3h`, `9d`. Coarse by one unit on purpose: the reader wants to
 * know whether the run is seconds or days old, not that it was 3h 12m.
 *
 * The elapsed milliseconds are computed at the *server* boundary and passed
 * in, never read from `Date.now()` here: a component that asked the clock
 * itself would render one string on the server and a different one in the
 * browser a moment later, which is a hydration mismatch.
 */
export function formatSince(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  return `${String(Math.floor(hours / 24))}d`
}
