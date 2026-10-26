/**
 * Shared display formatters. The date forms are hand-rolled, never `Intl`:
 * the server and the browser must print the same string or hydration fails,
 * and one formatter per form is how a table never mixes `12 Mar` with `Mar 12`.
 *
 * The date forms (design contract, "Dates"):
 * - today: the time, `10:42` — or `Today` in a readout;
 * - this year: the day, `13 Oct`;
 * - an older year: `4 Oct 2024`.
 *
 * `today` and `now` are always handed in from a loader or the server, never
 * read from the clock here. An instant is read in the process's clock (the
 * reader's, in the browser); a bare `YYYY-MM-DD` is a calendar day and is
 * never shifted by a zone.
 */

/** A string (ISO day or instant) or a `Date`. */
export type DateInput = string | Date

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

type Parts = {
  year: number
  /** 0-based, as `Date` counts it. */
  month: number
  day: number
  /** Null for a bare calendar day, which has no time. */
  time: { hours: number; minutes: number } | null
}

function partsOf(value: DateInput): Parts | null {
  if (typeof value === 'string') {
    const m = DAY_ONLY.exec(value)
    if (m) {
      return {
        year: Number(m[1]),
        month: Number(m[2]) - 1,
        day: Number(m[3]),
        time: null,
      }
    }
  }
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return null
  return {
    year: d.getFullYear(),
    month: d.getMonth(),
    day: d.getDate(),
    time: { hours: d.getHours(), minutes: d.getMinutes() },
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

const keyOf = (p: Parts) =>
  `${String(p.year)}-${pad(p.month + 1)}-${pad(p.day)}`

/**
 * The calendar day of a value as `YYYY-MM-DD` — the key a list groups and
 * compares by, never a printed form. `''` when the value is not a date.
 */
export function dayKey(value: DateInput): string {
  const p = partsOf(value)
  return p === null ? '' : keyOf(p)
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: DateInput, to: DateInput): number {
  const a = dayKey(from)
  const b = dayKey(to)
  if (a === '' || b === '') return 0
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  )
}

/** `10:42` — the time of an instant; `''` for a bare day or a non-date. */
export function formatTime(value: DateInput): string {
  const t = partsOf(value)?.time
  return t ? `${pad(t.hours)}:${pad(t.minutes)}` : ''
}

/**
 * `13 Oct` in `today`'s year, `4 Oct 2024` in any other; `''` when the value
 * is not a date.
 */
export function formatDay(value: DateInput, today: DateInput): string {
  const p = partsOf(value)
  if (p === null) return ''
  const day = `${String(p.day)} ${MONTHS[p.month]}`
  return partsOf(today)?.year === p.year ? day : `${day} ${String(p.year)}`
}

/**
 * `4 Oct 2024` whatever the year — for text that is stored or sent, which
 * outlives the year it was written in.
 */
export function formatFullDay(value: DateInput): string {
  const p = partsOf(value)
  return p === null
    ? ''
    : `${String(p.day)} ${MONTHS[p.month]} ${String(p.year)}`
}

/**
 * When something happened: `10:42` on `now`'s day (`Today` with `readout`,
 * and for a bare day, which has no time), else {@link formatDay}.
 */
export function formatWhen(
  value: DateInput,
  now: DateInput,
  opts: { readout?: boolean } = {},
): string {
  const p = partsOf(value)
  if (p === null) return ''
  if (keyOf(p) !== dayKey(now)) return formatDay(value, now)
  return opts.readout === true || p.time === null
    ? 'Today'
    : `${pad(p.time.hours)}:${pad(p.time.minutes)}`
}

/**
 * A due day: `−2d` once it has passed, its weekday (`Fri`) within the next
 * seven days, else the day (`14 Oct`).
 */
export function formatDue(day: DateInput, today: DateInput): string {
  const n = daysBetween(today, day)
  if (n < 0) return `−${String(-n)}d`
  if (n < 7) return weekdayOf(day)
  return formatDay(day, today)
}

/**
 * How old something is: `12d` under 30 days, else the day it happened — the
 * stat-column form (Last contact, Last email, Last filed).
 */
export function formatAge(value: DateInput, now: DateInput): string {
  if (dayKey(value) === '') return ''
  const n = daysBetween(value, now)
  return n < 30 ? `${String(Math.max(0, n))}d` : formatDay(value, now)
}

/** `Thu` — the weekday of a value; `''` when it is not a date. */
export function weekdayOf(value: DateInput): string {
  const p = partsOf(value)
  if (p === null) return ''
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month, p.day)).getUTCDay()]
}

/**
 * `Thu 15 Oct` — a day in prose, with the year when it is not `today`'s
 * (`Thu 15 Oct 2024`).
 */
export function formatWeekday(value: DateInput, today: DateInput): string {
  const w = weekdayOf(value)
  return w === '' ? '' : `${w} ${formatDay(value, today)}`
}

/** `THU 15 OCT` — the same day as a band label. */
export function formatWeekdayHead(value: DateInput, today: DateInput): string {
  return formatWeekday(value, today).toUpperCase()
}

const numberFmts = new Map<number, Intl.NumberFormat>()

/**
 * A plain number with thousands grouping and a fixed number of decimals —
 * the `number.precision` display rule. Grouping is off for precision-less
 * integers, which read as years ("Founded 1,987" is the bug otherwise).
 * Never compact notation: it differs between Node and Chrome and breaks
 * hydration; `fmtMoney` owns compact.
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
