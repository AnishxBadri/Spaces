import { clock, isoDay, shiftDay, weekdayDate } from './day'
import type { DayMeeting, MeetingRsvp } from './day'

/**
 * The Meetings page's pure half, client-safe: the row the list read hands
 * over, its filters and counts, the upcoming horizon and the day groups.
 * Times are read in the browser's clock.
 */

/**
 * Where a meeting's write-up stands for the reader.
 * - `none`: `note_id` is null.
 * - `private`: a write-up exists and canRead refuses it to the reader.
 */
export type WriteUpState = 'none' | 'written' | 'private'

/** One row of the Meetings page: a day row plus what the list needs. */
export type ListedMeeting = DayMeeting & {
  /** The reader is among the participants, or organized it. */
  mine: boolean
  /** The reader's own answer; null when no address of theirs is invited. */
  myRsvp: MeetingRsvp | null
  writeUp: WriteUpState
  /** The integration that wrote the write-up ("Granola"); null when a person did. */
  via: string | null
}

/**
 * The list read: `upcoming` earliest first; `past` with the meetings that
 * still need a write-up first, then newest first. `more` says the past was
 * cut at its limit.
 */
export type MeetingsList = {
  upcoming: Array<ListedMeeting>
  past: Array<ListedMeeting>
  more: boolean
}

/** How many past meetings the list reads at once. */
export const PAST_LIMIT = 300

/** The line under a past list cut at `PAST_LIMIT`. */
export const PAST_SHOWN_NOTE = `latest ${PAST_LIMIT} past meetings shown`

export const MEETING_FILTERS = [
  'all',
  'upcoming',
  'past',
  'unwritten',
  'mine',
] as const
export type MeetingFilter = (typeof MEETING_FILTERS)[number]

export const MEETING_FILTER_LABEL: Record<MeetingFilter, string> = {
  all: 'All',
  upcoming: 'Upcoming',
  past: 'Past',
  unwritten: 'No write-up',
  mine: 'Mine',
}

/** A past meeting that carries Write: nothing written, and it happened. */
export function needsWriteUp(m: ListedMeeting): boolean {
  return m.writeUp === 'none' && !m.cancelled
}

/** What one filter shows of the list, order kept. */
export function filterMeetings(
  list: Pick<MeetingsList, 'upcoming' | 'past'>,
  filter: MeetingFilter,
): Pick<MeetingsList, 'upcoming' | 'past'> {
  switch (filter) {
    case 'all':
      return { upcoming: list.upcoming, past: list.past }
    case 'upcoming':
      return { upcoming: list.upcoming, past: [] }
    case 'past':
      return { upcoming: [], past: list.past }
    case 'unwritten':
      return { upcoming: [], past: list.past.filter(needsWriteUp) }
    case 'mine':
      return {
        upcoming: list.upcoming.filter((m) => m.mine),
        past: list.past.filter((m) => m.mine),
      }
  }
}

/** Each filter's count, for its tab. The tabs carry the counts, nothing else. */
export function filterCounts(
  list: Pick<MeetingsList, 'upcoming' | 'past'>,
): Record<MeetingFilter, number> {
  const count = (f: MeetingFilter) => {
    const shown = filterMeetings(list, f)
    return shown.upcoming.length + shown.past.length
  }
  return {
    all: count('all'),
    upcoming: count('upcoming'),
    past: count('past'),
    unwritten: count('unwritten'),
    mine: count('mine'),
  }
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

/** An upcoming day's head: `Today · Mon 10-12`, `Tomorrow · …`, else `Wed 10-14`. */
export function dayHead(day: string, today: string): string {
  if (day === today) return `Today · ${weekdayDate(day)}`
  if (day === shiftDay(today, 1)) return `Tomorrow · ${weekdayDate(day)}`
  return weekdayDate(day)
}

/** A past row's when-lane: `10-08 09:30`, the reader's clock. */
export function pastWhen(startsAt: string): string {
  return `${isoDay(new Date(startsAt)).slice(5)} ${clock(startsAt)}`
}

/** A past row's state word: `written`, `via Granola`, `private`, `no write-up`. */
export function writeUpWord(m: ListedMeeting): string {
  if (m.cancelled) return 'cancelled'
  if (m.writeUp === 'private') return 'private'
  if (m.writeUp === 'written')
    return m.via === null ? 'written' : `via ${m.via}`
  return 'no write-up'
}
