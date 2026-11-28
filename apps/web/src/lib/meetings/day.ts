import type { AskRef } from '@spaces/db/schema/ask'
import type { MeetingRsvp } from '@spaces/db/schema/interactions'
import { formatTime, formatWeekday } from '@spaces/core/format'

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

/** One meeting row, the base of Today's and the Meetings page's. */
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

/** One row of Today's Meetings section and a block on its day strip. */
export type TodayMeeting = DayMeeting & {
  /** Participants outside the workspace, by name or address, in participant order. */
  external: ReadonlyArray<string>
  /** The call's address; null for a meeting in a room. */
  callLink: string | null
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

/** The day nav's middle word: `Today`, else the day, `Wed 14 Oct`. */
export function dayLabel(day: string, today: string): string {
  return day === today ? 'Today' : formatWeekday(day, today)
}

/** Where a day sits against today: what the strip dithers and a row offers. */
export type DayTense = 'past' | 'today' | 'future'

export function dayTense(day: string, today: string): DayTense {
  if (day === today) return 'today'
  return day < today ? 'past' : 'future'
}

/** The who lane: the first person outside the workspace, `Priya Raman +1`. */
export function whoLine(external: ReadonlyArray<string>): string | null {
  const first = external.at(0)
  if (first === undefined) return null
  return external.length === 1
    ? first
    : `${first} +${String(external.length - 1)}`
}

/**
 * A strip block's label: the first linked record that is not a person, else
 * the first person outside the workspace, else the title.
 */
export function stripLabel(m: TodayMeeting): string {
  return (
    m.records.find((r) => r.kind !== 'person')?.name ??
    m.external.at(0) ??
    m.title ??
    'Meeting'
  )
}

/** The wait until the next meeting starts: `45m`, `2h`, `2h 20m`. */
export function waitFor(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${String(m)}m`
  return m === 0 ? `${String(h)}h` : `${String(h)}h ${String(m)}m`
}

/** How long before it starts a call can be joined from Today's strip. */
export const JOIN_LEAD_MS = 10 * 60_000

/** What the day strip's head adds after its count, and its `Join ↗`. */
export type StripHead = {
  /** The wait to the next meeting today, `2h 20m`; null when none is left. */
  next: string | null
  /** The call to join now; null when none is live or about to start. */
  join: string | null
}

/**
 * The strip head's clock-bound parts, for today's meetings in start order.
 * `now` is null away from today and before the browser clock is read, so
 * neither part is said then. A call is joinable from `JOIN_LEAD_MS` before
 * its start until its end; of several, the latest to start, so one running
 * over never hides the next.
 */
export function stripHead(
  meetings: ReadonlyArray<{
    startsAt: string
    endsAt: string
    callLink: string | null
  }>,
  now: Date | null,
): StripHead {
  if (now === null) return { next: null, join: null }
  const t = now.getTime()
  const next = meetings.find((m) => Date.parse(m.startsAt) > t)
  const join = meetings
    .filter(
      (m) =>
        m.callLink !== null &&
        Date.parse(m.startsAt) - JOIN_LEAD_MS <= t &&
        t < Date.parse(m.endsAt),
    )
    .at(-1)
  return {
    next: next === undefined ? null : waitFor(Date.parse(next.startsAt) - t),
    join: join?.callLink ?? null,
  }
}

/** A row's time lane: `09:30–10:00`. */
export function timeSpan(startsAt: string, endsAt: string): string {
  return `${formatTime(startsAt)}–${formatTime(endsAt)}`
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

/** Whether a meeting is still ahead of `now`: what earns it a brief. */
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
 * One event of a brief's stream. `route` comes first when the call runs,
 * says how it was routed and counts the sources the model reads; `refused`
 * and `failed` end a stream that never reached a model. Nothing is stored.
 */
export type PrepEvent =
  | { type: 'route'; sensitive: boolean; line: string; sources: number }
  | { type: 'text'; text: string }
  | {
      type: 'done'
      /** The brief with `[ref]` citations as written, for the card and Ask. */
      body: string
      /** The cited sources the model was given, labelled. */
      refs: ReadonlyArray<AskRef>
      /** The same brief with its citations written as words: the note. */
      markdown: string
    }
  | { type: 'refused'; line: string }
  | { type: 'failed'; message: string }
