import { Cause, Effect, Exit, Layer } from 'effect'
import type { MeetingCancellation, MeetingClaim } from '@spaces/sdk'
import {
  CALENDAR_API,
  ContentTest,
  FAKE_CALENDAR_OWNER,
  HttpFetchTest,
  LogTest,
  SecretsTest,
  makeFakeCalendarApi,
} from '@spaces/sdk/testing'
import type { FakeCalendarApi, FakeCalendarEvent } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.ts'

/**
 * The sync job against the in-repo fake of Google Calendar's events.list:
 * no network, no Google project. The fake's demo calendar holds five-year-old
 * board meetings, last week's intro and this week's meetings, laid out around
 * `NOW`; the connection was made at `CONNECTED`.
 */
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const CONNECTED = '2026-10-10T09:00:00.000Z'

const harness = (api: FakeCalendarApi = makeFakeCalendarApi({ now: NOW })) => {
  const content = ContentTest()
  const log = LogTest()
  const layer = Layer.mergeAll(
    HttpFetchTest(api.fetch).layer,
    SecretsTest({ accessToken: api.accessToken }).layer,
    content.layer,
    log.layer,
  )
  const run = (cursor: string | null) =>
    Effect.runPromiseExit(
      plugin.jobs
        .sync({ cursor, connectedAt: CONNECTED })
        .pipe(Effect.provide(layer)),
    )
  const ok = async (cursor: string | null) => {
    const exit = await run(cursor)
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    return exit.value.nextCursor
  }
  const claims = () => content.calls.map((c) => c.input).filter(isClaim)
  return { api, content, log, run, ok, claims }
}

const isClaim = (x: unknown): x is MeetingClaim | MeetingCancellation =>
  typeof x === 'object' &&
  x !== null &&
  '_tag' in x &&
  (x._tag === 'meeting' || x._tag === 'meeting-cancelled')

const idOf = (out: unknown) =>
  typeof out === 'object' && out !== null && 'interactionId' in out
    ? out.interactionId
    : null

const uids = (claims: ReadonlyArray<MeetingClaim | MeetingCancellation>) =>
  claims.map((c) => c.uid).sort()

const failureOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null

describe('the first pull', () => {
  it('asks for events from the connection on, and nothing older is logged', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    expect(cursor).toMatch(/^sync-/)
    const first = h.api.requests.at(0)
    expect(first?.path).toBe('/calendars/primary/events')
    expect(first?.query).toMatchObject({
      timeMin: CONNECTED,
      singleEvents: 'true',
      showDeleted: 'true',
    })
    expect(first?.query.syncToken).toBeUndefined()
    expect(uids(h.claims())).toEqual(
      [
        'acme-catchup@google.com',
        'declined-pitch@google.com',
        'gamma-pitch@google.com',
        'standup@google.com',
      ].sort(),
    )
    for (const old of ['board-2021', 'board-2021b', 'intro-last-week'])
      expect(JSON.stringify(h.claims())).not.toContain(old)
  })

  it('hands over the meeting as the calendar has it, rooms left out', async () => {
    const h = harness()
    await h.ok(null)
    const acme = h.claims().find((c) => c.uid === 'acme-catchup@google.com')
    expect(acme).toEqual({
      _tag: 'meeting',
      uid: 'acme-catchup@google.com',
      eventId: 'acme-catchup',
      status: 'scheduled',
      startsAt: new Date(NOW + 2 * 86_400_000).toISOString(),
      endsAt: new Date(NOW + 2 * 86_400_000 + 3_600_000).toISOString(),
      subject: 'Acme Robotics catch-up',
      organizer: FAKE_CALENDAR_OWNER,
      conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      attendees: [
        {
          email: FAKE_CALENDAR_OWNER,
          name: 'Anish',
          rsvp: 'accepted',
          self: true,
        },
        {
          email: 'jane@acme-robotics.example',
          name: 'Jane Founder',
          rsvp: 'accepted',
        },
      ],
    })
  })
})

describe('resuming', () => {
  it('sends only the sync token, and logs only what changed', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const before = h.content.calls.length
    const event = h.api.events().find((e) => e.id === 'gamma-pitch')
    if (event === undefined) throw new Error('no gamma-pitch')
    h.api.put({
      ...event,
      attendees: [
        ...(event.attendees ?? []),
        {
          email: 'cto@gamma.example',
          displayName: 'Gamma CTO',
          responseStatus: 'tentative',
        },
      ],
    })
    const next = await h.ok(cursor)
    expect(next).not.toBe(cursor)
    expect(h.api.requests.at(-1)?.query).toMatchObject({ syncToken: cursor })
    expect(h.api.requests.at(-1)?.query.timeMin).toBeUndefined()
    const resumed = h.claims().slice(before)
    expect(uids(resumed)).toEqual(['gamma-pitch@google.com'])
    // The same row: the fake lane keys on uid, as the host's does.
    const born = h.content.calls.find(
      (c) => isClaim(c.input) && c.input.uid === 'gamma-pitch@google.com',
    )
    expect(born?.output).toMatchObject({ outcome: 'created' })
    const last = h.content.calls.at(-1)?.output
    expect(last).toMatchObject({ outcome: 'updated' })
    expect(idOf(last)).toBe(idOf(born?.output))
  })

  it('never writes an edit to an event that ended before the connection', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const before = h.content.calls.length
    const old = h.api.events().find((e) => e.id === 'board-2021')
    if (old === undefined) throw new Error('no board-2021')
    h.api.put({ ...old, summary: 'Board meeting (minutes attached)' })
    await h.ok(cursor)
    expect(h.content.calls.length).toBe(before)
    expect(h.log.lines.at(-1)?.fields).toMatchObject({ skipped: 1 })
  })

  it('sends a cancellation, and a bare one when Google sends only the id', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    h.api.cancel('gamma-pitch')
    h.api.cancel('acme-catchup', { minimal: true })
    await h.ok(cursor)
    const tail = h.claims().slice(-2)
    expect(tail.at(0)).toMatchObject({
      _tag: 'meeting',
      uid: 'gamma-pitch@google.com',
      status: 'cancelled',
    })
    expect(tail.at(1)).toEqual({
      _tag: 'meeting-cancelled',
      eventId: 'acme-catchup',
    })
  })
})

describe('the bad days', () => {
  it('an expired sync token is CursorInvalid, and the restart is bounded by the connection', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    h.api.expireSyncTokens()
    const expired = await h.run(cursor)
    expect(failureOf(expired)).toMatchObject({
      _tag: 'CursorInvalid',
      reason: 'Google expired the sync token',
    })
    // The host clears the cursor; the next run starts as the first did.
    const restarted = await h.ok(null)
    expect(restarted).toMatch(/^sync-2-/)
    expect(h.api.requests.at(-1)?.query).toMatchObject({ timeMin: CONNECTED })
    expect(JSON.stringify(h.claims())).not.toContain('board-2021')
  })

  it('a 429 is JobRateLimited with the provider’s Retry-After', async () => {
    const h = harness()
    h.api.rateLimit(1, 30)
    expect(failureOf(await h.run(null))).toMatchObject({
      _tag: 'JobRateLimited',
      retryAfterMs: 30_000,
    })
  })

  it('a token revoked mid-sync is ConnectionRefused, keeping what it had written', async () => {
    const api = makeFakeCalendarApi({ now: NOW, pageSize: 2 })
    // Revoked after the first page is answered.
    const fetch = api.fetch
    let served = 0
    const revoking: FakeCalendarApi = {
      ...api,
      fetch: (url, init) => {
        if (++served === 2) api.revoke()
        return fetch(url, init)
      },
    }
    const r = harness(revoking)
    const exit = await r.run(null)
    expect(failureOf(exit)).toMatchObject({
      _tag: 'ConnectionRefused',
      reason: 'Google refused the calendar connection: reconnect it',
    })
    // The first page's two meetings were written before the refusal.
    expect(r.claims().map((c) => c.eventId)).toEqual([
      'acme-catchup',
      'gamma-pitch',
    ])
  })
})

describe('one meeting, two calendars', () => {
  it('both syncs name it by the same iCalUID', async () => {
    const shared: FakeCalendarEvent = {
      id: 'shared-evt',
      iCalUID: '040000008200E00074C5B7101A82E008@outlook.example',
      status: 'confirmed',
      summary: 'Acme board prep',
      start: { dateTime: '2026-10-14T09:00:00Z' },
      end: { dateTime: '2026-10-14T10:00:00Z' },
      attendees: [
        { email: 'jane@acme-robotics.example', responseStatus: 'accepted' },
      ],
    }
    const mine = harness(makeFakeCalendarApi({ seed: [shared] }))
    const partners = harness(
      makeFakeCalendarApi({
        seed: [{ ...shared, id: 'partner-copy' }],
        accessToken: 'partner-token',
      }),
    )
    await mine.ok(null)
    await partners.ok(null)
    expect(uids(mine.claims())).toEqual(uids(partners.claims()))
    expect(uids(mine.claims())).toEqual([
      '040000008200E00074C5B7101A82E008@outlook.example',
    ])
  })

  it('an instance of a series is keyed by its original start too', async () => {
    const base = {
      iCalUID: 'weekly@google.com',
      status: 'confirmed',
      recurringEventId: 'weekly',
      attendees: [
        { email: 'jane@acme-robotics.example', responseStatus: 'accepted' },
      ],
    } as const
    const h = harness(
      makeFakeCalendarApi({
        seed: [
          {
            ...base,
            id: 'weekly_20261012T100000Z',
            start: { dateTime: '2026-10-12T10:00:00Z' },
            end: { dateTime: '2026-10-12T10:30:00Z' },
            originalStartTime: { dateTime: '2026-10-12T10:00:00Z' },
          },
          {
            ...base,
            id: 'weekly_20261019T100000Z',
            start: { dateTime: '2026-10-19T11:00:00Z' },
            end: { dateTime: '2026-10-19T11:30:00Z' },
            originalStartTime: { dateTime: '2026-10-19T10:00:00Z' },
          },
        ],
      }),
    )
    await h.ok(null)
    expect(uids(h.claims())).toEqual([
      'weekly@google.com#2026-10-12T10:00:00.000Z',
      'weekly@google.com#2026-10-19T10:00:00.000Z',
    ])
    expect(h.claims().at(1)).toMatchObject({
      recurringInstanceId: 'weekly_20261019T100000Z',
    })
  })
})

describe('the request', () => {
  it('goes to the Calendar API with the connection’s token', async () => {
    const h = harness()
    await h.ok(null)
    expect(h.api.requests.every((r) => r.url.startsWith(CALENDAR_API))).toBe(
      true,
    )
  })

  it('refuses to run without connectedAt rather than import history', async () => {
    const api = makeFakeCalendarApi({ now: NOW })
    const exit = await Effect.runPromiseExit(
      plugin.jobs
        .sync({ cursor: null })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              HttpFetchTest(api.fetch).layer,
              SecretsTest({ accessToken: api.accessToken }).layer,
              ContentTest().layer,
              LogTest().layer,
            ),
          ),
        ),
    )
    expect(failureOf(exit)).toMatchObject({ _tag: 'JobPermanent' })
    expect(api.requests).toEqual([])
  })
})
