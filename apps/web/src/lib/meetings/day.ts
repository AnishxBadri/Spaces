import type { MeetingRsvp } from '@spaces/db/schema/interactions'

/**
 * The meeting surfaces' pure half, client-safe: the row shapes the server
 * reads hand over, the local day a section shows, and the marks a row prints.
 * Times are read in the browser's clock, never the server's.
 */

export type { MeetingRsvp }

/** One person on a meeting, by address, named when a record answers to it. */
export type MeetingParticipant = {
  email: string
  /** The person record's name; null when no record holds the address. */
  name: string | null
  rsvp: MeetingRsvp
}

/** A record edged to the meeting (`interaction_entity`). */
export type MeetingRecord = {
  id: string
  kind: string
  name: string
  objectSlug: string | null
}

export type ArtifactRole = 'attachment' | 'transcript' | 'recording_link'

/** One row of Today's Meetings section. */
export type DayMeeting = {
  id: string
  title: string | null
  startsAt: string
  endsAt: string
  cancelled: boolean
  participants: ReadonlyArray<MeetingParticipant>
  records: ReadonlyArray<MeetingRecord>
  /** The artifact roles on the row, each once. */
  artifacts: ReadonlyArray<ArtifactRole>
  noteId: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` of a local date. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The local day `n` days after `day`. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return isoDay(new Date(y, m - 1, d + n))
}

/** A local day as the instants `[from, to)` the read takes. */
export function dayWindow(day: string): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number)
  return {
    from: new Date(y, m - 1, d).toISOString(),
    to: new Date(y, m - 1, d + 1).toISOString(),
  }
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A local day as `Tue 10-14`. */
export function weekdayDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${WEEKDAY[new Date(y, m - 1, d).getDay()]} ${day.slice(5)}`
}

/** The day nav's middle word: `today`, `tomorrow`, `yesterday`, else `Tue 10-14`. */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'today'
  if (day === shiftDay(today, 1)) return 'tomorrow'
  if (day === shiftDay(today, -1)) return 'yesterday'
  return weekdayDate(day)
}

/** `HH:MM` in the reader's clock. */
export function clock(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A row's time lane: `09:30–10:00`. */
export function timeSpan(startsAt: string, endsAt: string): string {
  return `${clock(startsAt)}–${clock(endsAt)}`
}

/** The dialog head's context: `Tue 10-14 · 09:30–10:00`. */
export function meetingWhen(startsAt: string, endsAt: string): string {
  return `${weekdayDate(isoDay(new Date(startsAt)))} · ${timeSpan(startsAt, endsAt)}`
}

/** The RSVP mark printed after a name. Shown, never edited. */
export const RSVP_MARK: Record<MeetingRsvp, string> = {
  accepted: '✓',
  declined: '✕',
  tentative: '?',
  needs_action: '·',
}

/** The words a mark stands for, for its title. */
export const RSVP_WORD: Record<MeetingRsvp, string> = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'maybe',
  needs_action: 'no answer',
}

/** A participant's printed name: the record's, else the address. */
export function participantName(p: MeetingParticipant): string {
  return p.name ?? p.email
}

/** The artifact marks a row ends on: `transcript · recording`. */
export function artifactMarks(roles: ReadonlyArray<ArtifactRole>): string {
  const words: Array<string> = []
  if (roles.includes('transcript')) words.push('transcript')
  if (roles.includes('recording_link')) words.push('recording')
  return words.join(' · ')
}

/** Whether a meeting is still ahead of `now`: what earns it Prep. */
export function isUpcoming(m: { startsAt: string }, now: Date): boolean {
  return Date.parse(m.startsAt) > now.getTime()
}

/**
 * Where the now-rule falls: the index of the first meeting that starts after
 * `now`, so the rule is drawn above it; the list's length when none does.
 */
export function nowIndex(
  meetings: ReadonlyArray<{ startsAt: string }>,
  now: Date,
): number {
  const i = meetings.findIndex((m) => isUpcoming(m, now))
  return i < 0 ? meetings.length : i
}

/** Google Calendar on the meeting's day, where RSVP is changed. */
export function googleDayUrl(startsAt: string): string {
  const d = new Date(startsAt)
  return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * One event of a Prep stream. `route` comes first when the call runs and
 * says how it was routed; `refused` and `failed` end a stream that never
 * reached a model. Prep is never stored.
 */
export type PrepEvent =
  | { type: 'route'; sensitive: boolean; line: string }
  | { type: 'text'; text: string }
  /** The whole brief with its citations written as words. */
  | { type: 'done'; markdown: string }
  | { type: 'refused'; line: string }
  | { type: 'failed'; message: string }
