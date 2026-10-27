import { dayKey, daysBetween } from '@spaces/core/format'

/**
 * Which week band a dated row falls in, counted from `today`'s Monday:
 * `This week`, `Last week` or `Earlier`. A row dated ahead of today is this
 * week's. Client-safe and pure, so the Interactions and History tabs and
 * their tests share it.
 */
export type WeekBand = 'This week' | 'Last week' | 'Earlier'

export const WEEK_BANDS: ReadonlyArray<WeekBand> = [
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
