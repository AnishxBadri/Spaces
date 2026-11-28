import type { MeetingRsvp } from '@spaces/db/schema/interactions'
import {
  daysBetween,
  dayKey,
  formatTime,
  formatWeekday,
} from '@spaces/core/format'
import { lengthOf, rowClock } from './list'
import type { MeetingRecord } from './day'

/**
 * The meeting sheet's pure half, client-safe: the shapes its read hands
 * over, how a reply is drawn, where a call is, the when-line, the head's
 * clock and when `Join ↗` stands. Times are read in the browser's clock.
 */

/** One person in the rail's `People`, in the read's order: the host first. */
export type SheetPerson = {
  email: string
  /** The person record's name, else the address. */
  name: string
  rsvp: MeetingRsvp
  /** The meeting's organiser. */
  host: boolean
  /** Outside the workspace, with nothing recorded before this meeting. */
  new: boolean
  /** One of the reader's own addresses. */
  you: boolean
  /** `Company · Title`, either alone; null when the record holds neither. */
  line: string | null
}

/** One row of `Recent`: what a thread row reads, plus a note's own kind. */
export type RecentRow = {
  id: string
  kind: 'email' | 'meeting' | 'call' | 'note'
  subject: string
  /** The row's note: an interaction's write-up, or the note itself. */
  noteId: string | null
  privateBody: boolean
  at: string
  attendees: ReadonlyArray<{ name: string; self: boolean }>
  sent: boolean
  attachments: number
  attachmentNames: ReadonlyArray<string>
  summary: string | null
  /** How many messages of its thread the read saw; 1 for anything else. */
  messages: number
}

/** The sheet's whole read: the window's read plus what the sheet adds. */
export type MeetingSheetExtras = {
  kind: 'meeting' | 'call'
  /** No earlier meeting or call with its company; false with no company. */
  firstMeeting: boolean
  people: Array<SheetPerson>
  recent: {
    /** The record the head links to: the first company, else the first record. */
    record: MeetingRecord | null
    rows: Array<RecentRow>
  }
}

/** A reply as the rail draws it: the square's fill and the word after it. */
export type ReplyDraw = {
  square: 'filled' | 'dithered' | 'hollow'
  word: string
  /** The word is struck, and both are graphite. */
  struck: boolean
}

/** Each stored reply as its square and word. */
export const REPLY: Record<MeetingRsvp, ReplyDraw> = {
  accepted: { square: 'filled', word: 'Yes', struck: false },
  tentative: { square: 'dithered', word: 'Maybe', struck: false },
  needs_action: { square: 'hollow', word: 'No reply', struck: false },
  declined: { square: 'hollow', word: 'Declined', struck: true },
}

/** Where a call is: the service's name, and the room's code when it has one. */
export type CallPlace = { name: string; code: string | null }

/**
 * A call link as `Where` names it: `Google Meet` and `kfp-wtzn-abq`, `Zoom`
 * and its meeting number, `Microsoft Teams`; any other link by its host.
 */
export function callPlace(url: string): CallPlace {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { name: 'Call link', code: null }
  }
  const host = parsed.hostname.replace(/^www\./, '')
  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  if (host === 'meet.google.com')
    return { name: 'Google Meet', code: segments.at(0) ?? null }
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
    const at = segments.indexOf('j')
    return { name: 'Zoom', code: at < 0 ? null : (segments.at(at + 1) ?? null) }
  }
  if (host === 'teams.microsoft.com' || host === 'teams.live.com')
    return { name: 'Microsoft Teams', code: null }
  return { name: host, code: null }
}

/** `in 5 days`, `in 1 day`, `2 days ago`; null on the reader's day. */
export function dayDistance(startsAt: string, today: string): string | null {
  const n = daysBetween(today, startsAt)
  if (n === 0) return null
  const days = `${String(Math.abs(n))} ${Math.abs(n) === 1 ? 'day' : 'days'}`
  return n > 0 ? `in ${days}` : `${days} ago`
}

/**
 * The when-line in its parts: `Thu 15 Oct`, `11:30–12:00` (the start alone
 * for a call with no end), `30m` and, away from today, `in 5 days`.
 */
export function whenLine(
  m: { startsAt: string; endsAt: string },
  today: string,
): {
  day: string
  time: string
  length: string | null
  distance: string | null
} {
  const start = formatTime(m.startsAt)
  const time =
    m.endsAt === m.startsAt ? start : `${start}–${formatTime(m.endsAt)}`
  return {
    day: formatWeekday(m.startsAt, today),
    time,
    length: lengthOf(m.startsAt, m.endsAt),
    distance: dayDistance(m.startsAt, today),
  }
}

/**
 * The head's clock on the title's baseline: `Now · 12m left` while it is
 * on, `in 8m` for the next meeting today, else nothing. `next` says whether
 * this one is the next today; null when the sheet has no list to ask, and
 * then any meeting still ahead today counts.
 */
export function headClock(
  m: { id: string; startsAt: string; endsAt: string; cancelled: boolean },
  now: Date,
  next: boolean | null,
): { kind: 'live' | 'next'; text: string } | null {
  const ahead =
    next ??
    (dayKey(m.startsAt) === dayKey(now) &&
      Date.parse(m.startsAt) > now.getTime())
  const clock = rowClock(m, now, ahead ? m.id : null)
  return clock.kind === 'live' || clock.kind === 'next' ? clock : null
}

/** How long before its start a call's `Join ↗` stands in the head. */
export const JOIN_LEAD_MS = 10 * 60_000

/** `Join ↗`: a call link, not cancelled, and on now or starting within 10 minutes. */
export function joinStands(
  m: {
    startsAt: string
    endsAt: string
    cancelled: boolean
    conferenceUrl: string | null
  },
  now: Date,
): boolean {
  if (m.conferenceUrl === null || m.cancelled) return false
  const t = now.getTime()
  return Date.parse(m.startsAt) - t <= JOIN_LEAD_MS && t < Date.parse(m.endsAt)
}

/** Whether a meeting is over: its body turns from the brief to the write-up. */
export function isOver(m: { endsAt: string }, now: Date): boolean {
  return Date.parse(m.endsAt) <= now.getTime()
}
