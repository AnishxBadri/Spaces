import { formatWeekdayHead, formatWhen } from '@spaces/core/format'
import { isoDay, shiftDay } from './day'
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
  /** Action items the write-up proposed, decided or still open; dismissed ones leave. */
  tasks: number
}

/**
 * The list read: `upcoming` earliest first; `past` with the meetings that
 * still need a write-up first, then newest first, cut at `PAST_LIMIT`.
 * - `earlier`: the past meetings the cut left out.
 * - `counts`: each filter's count over every meeting, not just the rows sent.
 */
export type MeetingsList = {
  upcoming: Array<ListedMeeting>
  past: Array<ListedMeeting>
  earlier: number
  counts: Record<MeetingFilter, number>
}

/** How many past meetings the list reads at once. */
export const PAST_LIMIT = 300

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

/** An upcoming day's band: `TODAY · MON 12 OCT`, else `WED 14 OCT`. */
export function dayHead(day: string, today: string): string {
  const head = formatWeekdayHead(day, today)
  return day === today ? `TODAY · ${head}` : head
}

/** A past row's when-lane: the time on `now`'s day, else the day (`8 Oct`). */
export function pastWhen(startsAt: string, now: string): string {
  return formatWhen(startsAt, now)
}

/**
 * A past row's state: `Cancelled`, `No write-up`, `Private`, or `Write-up`
 * with the tasks it proposed (`Write-up · 2 tasks`).
 */
export function writeUpWord(m: ListedMeeting): string {
  if (m.cancelled) return 'Cancelled'
  if (m.writeUp === 'private') return 'Private'
  if (m.writeUp === 'written')
    return m.tasks === 0
      ? 'Write-up'
      : `Write-up · ${m.tasks} task${m.tasks === 1 ? '' : 's'}`
  return 'No write-up'
}
