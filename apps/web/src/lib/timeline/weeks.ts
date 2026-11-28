import { dayKey, daysBetween } from '@spaces/core/format'

/**
 * Which band a dated row falls in, counted from `today`'s Monday:
 * `Upcoming` for a day after today, then `This week`, `Last week` or
 * `Earlier`. A week band holds only what has happened. Client-safe and pure,
 * so the Interactions and History tabs and their tests share it.
 */
export type WeekBand = 'Upcoming' | 'This week' | 'Last week' | 'Earlier'

export const WEEK_BANDS: ReadonlyArray<WeekBand> = [
  'Upcoming',
  'This week',
  'Last week',
  'Earlier',
]

export function weekBand(at: string, today: string): WeekBand {
  const key = dayKey(today)
  // Monday is 0: the weekday of the calendar day, read in UTC so the key's
  // midnight cannot slip a day.
  const weekday = (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7
  const ago = daysBetween(at, today)
  if (ago < 0) return 'Upcoming'
  if (ago <= weekday) return 'This week'
  if (ago <= weekday + 7) return 'Last week'
  return 'Earlier'
}

/** Rows split into their week bands, in band order, empty bands left out. */
export function byWeek<T extends { at: string }>(
  rows: ReadonlyArray<T>,
  today: string,
): Array<{ band: WeekBand; rows: Array<T> }> {
  return WEEK_BANDS.map((band) => ({
    band,
    rows: rows.filter((r) => weekBand(r.at, today) === band),
  })).filter((g) => g.rows.length > 0)
}

/** How many rows ahead of now show before the `n more` fold. */
export const UPCOMING_SHOWN = 3

/**
 * Rows still ahead of `now` taken out of the rest, earliest first: the first
 * {@link UPCOMING_SHOWN} shown and the others behind the fold. `past` keeps
 * the input's order. Split by the instant, not the day, so a meeting later
 * today is ahead and one this morning has happened.
 */
export function upcomingSplit<T extends { at: string }>(
  rows: ReadonlyArray<T>,
  now: string,
): { shown: Array<T>; folded: Array<T>; past: Array<T> } {
  const at = Date.parse(now)
  const ahead = rows
    .filter((r) => Date.parse(r.at) > at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return {
    shown: ahead.slice(0, UPCOMING_SHOWN),
    folded: ahead.slice(UPCOMING_SHOWN),
    past: rows.filter((r) => !(Date.parse(r.at) > at)),
  }
}
