import type { JsonValue } from '../contract.ts'
import type { FetchLike } from './fake-drive-api.ts'

/**
 * Google Calendar's v3 `events.list`, in process: a `fetch`-shaped function
 * a syncer's real HTTP code runs against — `timeMin`, `syncToken`,
 * `showDeleted`, `singleEvents`, paging — with toggles for the bad days
 * (`expireSyncTokens`, `rateLimit`, `revoke`).
 *
 * - Every request is recorded with its query, so a test asserts what was sent.
 * - Events are stored already expanded, one per instance, so a request must
 *   ask `singleEvents=true`; `syncToken` with `timeMin` is a 400, as Google's.
 * - A full list filters on `timeMin` against the event's end; without it,
 *   it lists all of history — the gap a syncer must not leave open.
 * - An incremental list returns every event changed since its token,
 *   cancellations included, whatever their dates.
 * - A cancellation marked `minimal` answers with its id alone, which is all
 *   Google promises for a deleted event.
 */

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/** The demo workspace's own address: the connected calendar's owner. */
export const FAKE_CALENDAR_OWNER = 'anish@fund.example'

/** The bearer token the fake accepts unless given another. */
export const FAKE_CALENDAR_TOKEN = 'fake-google-calendar-token'

export type FakeCalendarTime =
  { readonly dateTime: string } | { readonly date: string }

export type FakeCalendarAttendee = {
  readonly email: string
  readonly displayName?: string
  readonly responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction'
  readonly self?: boolean
  readonly organizer?: boolean
  readonly resource?: boolean
}

export type FakeCalendarEvent = {
  readonly id: string
  readonly iCalUID: string
  readonly status: 'confirmed' | 'tentative' | 'cancelled'
  readonly summary?: string
  readonly start: FakeCalendarTime
  readonly end: FakeCalendarTime
  readonly attendees?: ReadonlyArray<FakeCalendarAttendee>
  readonly organizer?: { readonly email: string; readonly self?: boolean }
  readonly hangoutLink?: string
  readonly recurringEventId?: string
  readonly originalStartTime?: FakeCalendarTime
}

/** One request the fake received. `path` is relative to `CALENDAR_API`. */
export type CalendarApiRequest = {
  readonly method: string
  readonly url: string
  readonly path: string
  /** A parameter the request did not send reads as undefined. */
  readonly query: { readonly [name: string]: string | undefined }
}

export type FakeCalendarApi = {
  readonly fetch: FetchLike
  readonly requests: ReadonlyArray<CalendarApiRequest>
  readonly accessToken: string
  /** Adds or replaces an event; it reads as changed to every older sync token. */
  readonly put: (event: FakeCalendarEvent, calendarId?: string) => void
  /** Cancels an event. `minimal`: later lists show only its id and status. */
  readonly cancel: (
    eventId: string,
    options?: { readonly calendarId?: string; readonly minimal?: boolean },
  ) => void
  readonly events: (calendarId?: string) => ReadonlyArray<FakeCalendarEvent>
  /** Every sync token issued so far answers 410 from now on. */
  readonly expireSyncTokens: () => void
  /** The next `times` requests answer 429 with this `Retry-After`, in seconds. */
  readonly rateLimit: (times: number, retryAfterSeconds: number) => void
  /** The token is revoked: every later request is a 401. */
  readonly revoke: () => void
}

export type FakeCalendarApiOptions = {
  /** The events on `primary`; `fakeCalendarSeed` when absent. */
  readonly seed?: ReadonlyArray<FakeCalendarEvent>
  /** The instant the default seed is laid out around; `Date.now()` when absent. */
  readonly now?: number
  readonly accessToken?: string
  /** Items per page; Google's default of 250 when absent. */
  readonly pageSize?: number
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const at = (ms: number): FakeCalendarTime => ({
  dateTime: new Date(ms).toISOString(),
})

const external = (
  id: string,
  summary: string,
  startMs: number,
  attendees: ReadonlyArray<FakeCalendarAttendee>,
  extra: Partial<FakeCalendarEvent> = {},
): FakeCalendarEvent => ({
  id,
  iCalUID: `${id}@google.com`,
  status: 'confirmed',
  summary,
  start: at(startMs),
  end: at(startMs + HOUR),
  organizer: { email: FAKE_CALENDAR_OWNER, self: true },
  attendees: [
    {
      email: FAKE_CALENDAR_OWNER,
      displayName: 'Anish',
      responseStatus: 'accepted',
      self: true,
      organizer: true,
    },
    ...attendees,
  ],
  ...extra,
})

/**
 * The demo calendar, laid out around `now`: five-year-old board meetings
 * and last week's intro, which a forward-only sync never fetches; this
 * week's external meetings; an internal standup; a pitch the owner declined.
 * The workspace is `fund.example`.
 */
export const fakeCalendarSeed = (now: number): Array<FakeCalendarEvent> => [
  external('board-2021', 'Board meeting — Acme Robotics', now - 5 * 365 * DAY, [
    {
      email: 'jane@acme-robotics.example',
      displayName: 'Jane Founder',
      responseStatus: 'accepted',
    },
  ]),
  external('board-2021b', 'Board follow-up', now - 5 * 365 * DAY + DAY, [
    {
      email: 'cfo@acme-robotics.example',
      displayName: 'Acme CFO',
      responseStatus: 'accepted',
    },
  ]),
  external('intro-last-week', 'Intro — Beta Labs', now - 7 * DAY, [
    {
      email: 'sam@betalabs.example',
      displayName: 'Sam Beta',
      responseStatus: 'accepted',
    },
  ]),
  external(
    'acme-catchup',
    'Acme Robotics catch-up',
    now + 2 * DAY,
    [
      {
        email: 'jane@acme-robotics.example',
        displayName: 'Jane Founder',
        responseStatus: 'accepted',
      },
      {
        email: 'room-4@resource.calendar.google.com',
        displayName: 'Room 4',
        responseStatus: 'accepted',
        resource: true,
      },
    ],
    { hangoutLink: 'https://meet.google.com/abc-defg-hij' },
  ),
  external('gamma-pitch', 'Gamma pitch', now + 3 * DAY, [
    {
      email: 'lee@gamma.example',
      displayName: 'Lee Gamma',
      responseStatus: 'needsAction',
    },
  ]),
  external('standup', 'Partner standup', now + DAY, [
    {
      email: 'partner@fund.example',
      displayName: 'A Partner',
      responseStatus: 'accepted',
    },
  ]),
  {
    ...external('declined-pitch', 'Delta pitch', now + 4 * DAY, [
      {
        email: 'kim@delta.example',
        displayName: 'Kim Delta',
        responseStatus: 'accepted',
      },
    ]),
    organizer: { email: 'kim@delta.example' },
    attendees: [
      {
        email: FAKE_CALENDAR_OWNER,
        responseStatus: 'declined',
        self: true,
      },
      {
        email: 'kim@delta.example',
        displayName: 'Kim Delta',
        responseStatus: 'accepted',
        organizer: true,
      },
    ],
  },
]

const json = (
  status: number,
  body: JsonValue,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** Google's error envelope. */
const calendarError = (
  status: number,
  reason: string,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  json(
    status,
    { error: { code: status, message, errors: [{ reason, message }] } },
    headers,
  )

const instantOf = (time: FakeCalendarTime): number =>
  'dateTime' in time
    ? Date.parse(time.dateTime)
    : Date.parse(`${time.date}T00:00:00Z`)

type Stored = {
  event: FakeCalendarEvent
  version: number
  minimal: boolean
}

const SYNC_TOKEN = /^sync-(\d+)-(\d+)$/
const PAGE_TOKEN = /^page-(\d+)$/

export const makeFakeCalendarApi = (
  options: FakeCalendarApiOptions = {},
): FakeCalendarApi => {
  const accessToken = options.accessToken ?? FAKE_CALENDAR_TOKEN
  const pageSize = options.pageSize ?? 250
  const calendars = new Map<string, Map<string, Stored>>()
  const requests: Array<CalendarApiRequest> = []
  let version = 0
  let generation = 1
  let revoked = false
  let limited = { times: 0, retryAfter: 1 }

  const calendar = (id: string) => {
    const key = id === 'primary' ? FAKE_CALENDAR_OWNER : id
    let held = calendars.get(key)
    if (held === undefined) {
      held = new Map()
      calendars.set(key, held)
    }
    return held
  }

  const put = (event: FakeCalendarEvent, calendarId = 'primary') => {
    calendar(calendarId).set(event.id, {
      event,
      version: ++version,
      minimal: false,
    })
  }

  for (const event of options.seed ??
    fakeCalendarSeed(options.now ?? Date.now()))
    put(event)

  const list = (
    calendarId: string,
    query: { readonly [name: string]: string | undefined },
  ): Response => {
    if (query.singleEvents !== 'true')
      return calendarError(
        400,
        'badRequest',
        'The fake lists expanded instances only: ask singleEvents=true.',
      )
    if (query.syncToken !== undefined && query.timeMin !== undefined)
      return calendarError(
        400,
        'invalid',
        'Sync token cannot be used with other filters.',
      )
    let since: number | null = null
    if (query.syncToken !== undefined) {
      const token = SYNC_TOKEN.exec(query.syncToken)
      if (token === null || Number(token[1]) !== generation)
        return calendarError(
          410,
          'fullSyncRequired',
          'Sync token is no longer valid, a full sync is required.',
        )
      since = Number(token[2])
    }
    const floor = query.timeMin === undefined ? null : Date.parse(query.timeMin)
    if (floor !== null && Number.isNaN(floor))
      return calendarError(400, 'invalid', 'Bad timeMin.')
    const showDeleted = query.showDeleted === 'true'
    const matching = [...calendar(calendarId).values()]
      .filter((stored) => {
        if (since !== null) return stored.version > since
        if (stored.event.status === 'cancelled' && !showDeleted) return false
        return floor === null || instantOf(stored.event.end) > floor
      })
      .sort((a, b) => a.version - b.version)
    const offset =
      query.pageToken === undefined
        ? 0
        : Number(PAGE_TOKEN.exec(query.pageToken)?.[1] ?? Number.NaN)
    if (Number.isNaN(offset))
      return calendarError(400, 'invalid', 'Bad pageToken.')
    const size = Math.min(
      pageSize,
      query.maxResults === undefined ? pageSize : Number(query.maxResults),
    )
    const page = matching.slice(offset, offset + size)
    const items: Array<JsonValue> = page.map((stored) =>
      stored.minimal
        ? { kind: 'calendar#event', id: stored.event.id, status: 'cancelled' }
        : { kind: 'calendar#event', ...stored.event },
    )
    const more = offset + size < matching.length
    return json(200, {
      kind: 'calendar#events',
      items,
      ...(more
        ? { nextPageToken: `page-${offset + size}` }
        : { nextSyncToken: `sync-${generation}-${version}` }),
    })
  }

  const EVENTS = /^\/calendars\/([^/]+)\/events$/

  const fetch: FetchLike = (url, init) => {
    const parsed = new URL(url)
    const query: { [name: string]: string } = {}
    parsed.searchParams.forEach((value, name) => {
      query[name] = value
    })
    const base = `${parsed.origin}${parsed.pathname}`
    const path = base.startsWith(CALENDAR_API)
      ? base.slice(CALENDAR_API.length)
      : parsed.pathname
    requests.push({ method: init.method, url, path, query })
    if (!base.startsWith(CALENDAR_API))
      return Promise.resolve(
        calendarError(404, 'notFound', `${url} is not the Calendar API`),
      )
    const authorization = Object.entries(init.headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1]
    if (revoked || authorization !== `Bearer ${accessToken}`)
      return Promise.resolve(
        calendarError(401, 'authError', 'Invalid Credentials'),
      )
    if (limited.times > 0) {
      limited = { ...limited, times: limited.times - 1 }
      return Promise.resolve(
        calendarError(429, 'rateLimitExceeded', 'Rate Limit Exceeded', {
          'retry-after': String(limited.retryAfter),
        }),
      )
    }
    const calendarId = EVENTS.exec(path)?.[1]
    if (init.method !== 'GET' || calendarId === undefined)
      return Promise.resolve(
        calendarError(404, 'notFound', `${init.method} ${path} is not served`),
      )
    return Promise.resolve(list(decodeURIComponent(calendarId), query))
  }

  return {
    fetch,
    requests,
    accessToken,
    put,
    cancel: (eventId, cancelOptions = {}) => {
      const held = calendar(cancelOptions.calendarId ?? 'primary')
      const stored = held.get(eventId)
      if (stored === undefined) throw new Error(`no event ${eventId}`)
      held.set(eventId, {
        event: { ...stored.event, status: 'cancelled' },
        version: ++version,
        minimal: cancelOptions.minimal ?? false,
      })
    },
    events: (calendarId = 'primary') =>
      [...calendar(calendarId).values()].map((stored) => stored.event),
    expireSyncTokens: () => {
      generation++
    },
    rateLimit: (times, retryAfterSeconds) => {
      limited = { times, retryAfter: retryAfterSeconds }
    },
    revoke: () => {
      revoked = true
    },
  }
}
