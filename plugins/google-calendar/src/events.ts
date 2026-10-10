import { z } from 'zod'
import type {
  MeetingAttendee,
  MeetingCancellation,
  MeetingClaim,
  MeetingRsvp,
} from '@spaces/sdk'

/**
 * Google Calendar's events, read and turned into meeting claims. Pure: no
 * port, no clock — the job decides what to fetch and where to send it.
 */

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

const time = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
})

const attendee = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  self: z.boolean().optional(),
  resource: z.boolean().optional(),
})

const entryPoint = z.object({
  entryPointType: z.string().optional(),
  uri: z.string().optional(),
})

/** The fields of an `Event` resource this plugin reads. */
export const calendarEvent = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  iCalUID: z.string().min(1).optional(),
  summary: z.string().optional(),
  start: time.optional(),
  end: time.optional(),
  attendees: z.array(attendee).optional(),
  organizer: z.object({ email: z.string().optional() }).optional(),
  hangoutLink: z.string().optional(),
  conferenceData: z
    .object({ entryPoints: z.array(entryPoint).optional() })
    .optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: time.optional(),
})

export type CalendarEvent = z.output<typeof calendarEvent>

/** One `events.list` page; items are read one by one so a bad one is skipped alone. */
export const eventsPage = z.object({
  items: z.array(z.unknown()).default([]),
  nextPageToken: z.string().min(1).optional(),
  nextSyncToken: z.string().min(1).optional(),
})

/** Items per page, Google's ceiling. */
export const PAGE_SIZE = 2500

/**
 * The list request. The first pull is bounded by `timeMin`; every later one
 * resumes from the sync token alone, which Google refuses beside any filter.
 * `singleEvents` and `showDeleted` are the same on both, as the token needs.
 */
export const listUrl = (
  from: { readonly syncToken: string } | { readonly timeMin: string },
  pageToken: string | undefined,
): string => {
  const query = new URLSearchParams({
    singleEvents: 'true',
    showDeleted: 'true',
    maxResults: String(PAGE_SIZE),
  })
  if ('syncToken' in from) query.set('syncToken', from.syncToken)
  else query.set('timeMin', from.timeMin)
  if (pageToken !== undefined) query.set('pageToken', pageToken)
  return `${CALENDAR_API}/calendars/primary/events?${query.toString()}`
}

/** An event time as an ISO instant; an all-day date is its UTC midnight. */
export const instantOf = (
  value: z.output<typeof time> | undefined,
): string | null => {
  const raw =
    value?.dateTime ??
    (value?.date === undefined ? undefined : `${value.date}T00:00:00Z`)
  if (raw === undefined) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

const RSVP: { readonly [status: string]: MeetingRsvp } = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  needsAction: 'needs_action',
}

const attendeesOf = (event: CalendarEvent): Array<MeetingAttendee> =>
  (event.attendees ?? []).flatMap((a) =>
    a.resource === true || a.email === undefined || a.email.trim() === ''
      ? []
      : [
          {
            email: a.email,
            ...(a.displayName === undefined ? {} : { name: a.displayName }),
            rsvp:
              a.responseStatus !== undefined &&
              Object.hasOwn(RSVP, a.responseStatus)
                ? RSVP[a.responseStatus]
                : 'needs_action',
            ...(a.self === true ? { self: true } : {}),
          },
        ],
  )

const conferenceUrlOf = (event: CalendarEvent): string | undefined =>
  event.hangoutLink ??
  event.conferenceData?.entryPoints?.find(
    (p) => p.entryPointType === 'video' && p.uri !== undefined,
  )?.uri

/**
 * The row key: the iCalendar UID, plus the instance's original start for
 * one occurrence of a series — every occurrence shares the UID, and RFC
 * 5545 tells them apart by RECURRENCE-ID.
 */
export const uidOf = (event: CalendarEvent): string | null => {
  if (event.iCalUID === undefined) return null
  if (event.recurringEventId === undefined) return event.iCalUID
  const original = instantOf(event.originalStartTime)
  return original === null ? event.iCalUID : `${event.iCalUID}#${original}`
}

export type Mapped =
  | {
      readonly _tag: 'claim'
      readonly claim: MeetingClaim | MeetingCancellation
    }
  | {
      readonly _tag: 'skip'
      readonly reason: 'before-connection' | 'unreadable'
    }

/**
 * One event → what the job sends.
 * - A cancellation with no times is Google's minimal deleted event: it can
 *   only mark a meeting already held.
 * - An event that ended before the connection is skipped, cancelled or not:
 *   the change feed reports edits to old events too, and nothing older than
 *   the connection is ever written.
 */
export const mapEvent = (event: CalendarEvent, connectedAt: string): Mapped => {
  const cancelled = event.status === 'cancelled'
  const uid = uidOf(event)
  const startsAt = instantOf(event.start)
  const endsAt = instantOf(event.end)
  if (startsAt === null || endsAt === null || uid === null) {
    if (!cancelled) return { _tag: 'skip', reason: 'unreadable' }
    return {
      _tag: 'claim',
      claim: {
        _tag: 'meeting-cancelled',
        eventId: event.id,
        ...(uid === null ? {} : { uid }),
      },
    }
  }
  if (Date.parse(endsAt) < Date.parse(connectedAt))
    return { _tag: 'skip', reason: 'before-connection' }
  const conferenceUrl = conferenceUrlOf(event)
  return {
    _tag: 'claim',
    claim: {
      _tag: 'meeting',
      uid,
      eventId: event.id,
      status: cancelled ? 'cancelled' : 'scheduled',
      startsAt,
      endsAt,
      ...(event.summary === undefined ? {} : { subject: event.summary }),
      ...(event.organizer?.email === undefined
        ? {}
        : { organizer: event.organizer.email }),
      ...(conferenceUrl === undefined ? {} : { conferenceUrl }),
      ...(event.recurringEventId === undefined
        ? {}
        : { recurringInstanceId: event.id }),
      attendees: attendeesOf(event),
    },
  }
}
