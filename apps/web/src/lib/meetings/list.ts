import { dayKey, formatDay, weekdayOf } from '@spaces/core/format'
import { weekBand } from '#/lib/timeline/weeks'
import { isoDay, shiftDay, waitFor } from './day'
import type { MeetingRecord } from './day'

/**
 * The Meetings page's pure half, client-safe: the list read's params and
 * rows, the upcoming horizon, the agenda's days and time lanes, Past's bands
 * and which meeting the pane opens. Times are read in the browser's clock.
 */

export const MEETINGS_TABS = ['upcoming', 'past'] as const
export type MeetingsTab = (typeof MEETINGS_TABS)[number]

/** Whose meetings the list holds: the reader's, or the whole team's. */
export const WHOSE = ['mine', 'everyone'] as const
export type Whose = (typeof WHOSE)[number]

export const WHOSE_LABEL: Record<Whose, string> = {
  mine: 'Mine',
  everyone: 'Everyone',
}

/** How many past meetings one page of Past reads. */
export const PAST_STEP = 50

/**
 * The list read's one params object. Filter, `Jump to` and the search
 * extend it; the read takes nothing else.
 */
export type MeetingsQuery = {
  tab: MeetingsTab
  whose: Whose
  /** The reader's instant: what is still ahead, and how late a write-up is. */
  now: string
  /** Upcoming's end: the reader's Monday after next. */
  until: string
  /** Past's next page, from the page before; absent for the first. */
  cursor?: string | undefined
}

/**
 * Where a meeting's write-up stands for the reader.
 * - `none`: `note_id` is null.
 * - `private`: a write-up exists and canRead refuses it to the reader.
 */
export type WriteUpState = 'none' | 'written' | 'private'

/** One row of the Meetings page, upcoming or past. */
export type ListedMeeting = {
  id: string
  kind: 'meeting' | 'call'
  title: string | null
  startsAt: string
  endsAt: string
  cancelled: boolean
  /** Who it is with, by name or address: never the reader, never a member. */
  people: ReadonlyArray<string>
  /** The record it is about: the first linked record that is not a person. */
  record: MeetingRecord | null
  /** It has a call link (the camera glyph). */
  callLink: boolean
  /** The reader organised it, was invited, or logged it. */
  mine: boolean
  /** Our members in it other than the reader, by name. */
  members: ReadonlyArray<string>
  noteId: string | null
  writeUp: WriteUpState
  /** The write-up's summary, only when the reader may read it. */
  summary: string | null
  /** The integration that wrote the write-up ("Granola"); null when a person did. */
  via: string | null
  /** It still owes a write-up, by `isUnwritten` at the read's `now`. */
  unwritten: boolean
}

export type MeetingCounts = {
  upcoming: number
  past: number
  /** Past meetings that owe a write-up: Past's first band. */
  unwritten: number
}

/** One page of the list read, its counts over every meeting the tab holds. */
export type MeetingsPage = {
  rows: Array<ListedMeeting>
  /** Past's next page; null when this was the last, and always for Upcoming. */
  nextCursor: string | null
  counts: MeetingCounts
}

/**
 * The end of "this week and next": the local Monday after next, at
 * midnight. Weeks start on Monday, as the date line's `W41` does.
 */
export function upcomingHorizon(now: Date): Date {
  const toMonday = (8 - now.getDay()) % 7 || 7
  const [y, m, d] = shiftDay(isoDay(now), toMonday + 7)
    .split('-')
    .map(Number)
  return new Date(y, m - 1, d)
}

/** Meetings grouped under their local day, in the order given. */
export function byDay<T extends { startsAt: string }>(
  meetings: ReadonlyArray<T>,
): Array<{ day: string; meetings: Array<T> }> {
  const out: Array<{ day: string; meetings: Array<T> }> = []
  for (const m of meetings) {
    const day = isoDay(new Date(m.startsAt))
    const last = out.at(-1)
    if (last?.day === day) last.meetings.push(m)
    else out.push({ day, meetings: [m] })
  }
  return out
}

/** Two names, then how many more: `Priya Nair, Maya Chen +1`. */
export function peopleLine(people: ReadonlyArray<string>): string {
  const shown = people.slice(0, 2).join(', ')
  const rest = people.length - 2
  return rest > 0 ? `${shown} +${String(rest)}` : shown
}

/** How long a meeting runs: `30m`, `1h`, `1h 30m`; null when it has no length. */
export function lengthOf(startsAt: string, endsAt: string): string | null {
  const ms = Date.parse(endsAt) - Date.parse(startsAt)
  return ms > 0 ? waitFor(ms) : null
}

/**
 * The id of the next meeting today: the first not cancelled that starts
 * after `now` on `now`'s local day; null when none is left today.
 */
export function nextToday(
  rows: ReadonlyArray<Pick<ListedMeeting, 'id' | 'startsAt' | 'cancelled'>>,
  now: Date,
): string | null {
  const today = isoDay(now)
  const next = rows.find(
    (m) =>
      !m.cancelled &&
      Date.parse(m.startsAt) > now.getTime() &&
      isoDay(new Date(m.startsAt)) === today,
  )
  return next?.id ?? null
}

/** What an agenda row's end shows in place of its length. */
export type RowClock =
  | { kind: 'live'; text: string }
  | { kind: 'next'; text: string }
  | { kind: 'length'; text: string | null }
  | { kind: 'cancelled' }

/**
 * An agenda row's end: `Now · 12m left` while it is on, `in 8m` for the
 * next meeting today, else its length. A cancelled meeting shows nothing.
 */
export function rowClock(
  m: Pick<ListedMeeting, 'id' | 'startsAt' | 'endsAt' | 'cancelled'>,
  now: Date,
  next: string | null,
): RowClock {
  if (m.cancelled) return { kind: 'cancelled' }
  const t = now.getTime()
  const start = Date.parse(m.startsAt)
  const end = Date.parse(m.endsAt)
  if (start <= t && t < end)
    return { kind: 'live', text: `Now · ${waitFor(end - t)} left` }
  if (m.id === next) return { kind: 'next', text: `in ${waitFor(start - t)}` }
  return { kind: 'length', text: lengthOf(m.startsAt, m.endsAt) }
}

/**
 * The meeting the pane opens when the address names none: Upcoming's next
 * meeting that is not cancelled, Past's first row; null for an empty list.
 */
export function defaultOpen(
  tab: MeetingsTab,
  rows: ReadonlyArray<Pick<ListedMeeting, 'id' | 'cancelled'>>,
): string | null {
  const first = tab === 'upcoming' ? rows.find((m) => !m.cancelled) : rows.at(0)
  return first?.id ?? null
}

/** A past row's day: the weekday this week (`Tue`), else the day (`7 Oct`). */
export function pastDay(startsAt: string, today: string): string {
  return weekBand(startsAt, today) === 'This week'
    ? weekdayOf(startsAt)
    : formatDay(startsAt, today)
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** A month band's name: `September`, with the year when not `today`'s. */
function monthBand(startsAt: string, today: string): string {
  const [y, m] = dayKey(startsAt).split('-').map(Number)
  const name = MONTHS[m - 1]
  return String(y) === dayKey(today).slice(0, 4) ? name : `${name} ${String(y)}`
}

/** One band of Past: `No write-up` first, then the weeks, then months. */
export type PastBand<T> = { key: string; label: string; rows: Array<T> }

/**
 * Past's bands in the order read: the meetings owing a write-up under
 * `No write-up`, then `This week`, `Last week` and a band per month. The
 * read sends the unwritten first and the rest newest first, so a band is
 * never split.
 */
export function pastBands<
  T extends Pick<ListedMeeting, 'startsAt' | 'unwritten'>,
>(rows: ReadonlyArray<T>, today: string): Array<PastBand<T>> {
  const out: Array<PastBand<T>> = []
  for (const m of rows) {
    const week = weekBand(m.startsAt, today)
    const label = m.unwritten
      ? 'No write-up'
      : week === 'Earlier'
        ? monthBand(m.startsAt, today)
        : week
    const key = m.unwritten ? 'unwritten' : label
    const last = out.at(-1)
    if (last?.key === key) last.rows.push(m)
    else out.push({ key, label, rows: [m] })
  }
  return out
}
