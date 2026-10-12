import { Effect, Redacted } from 'effect'
import {
  ConnectionRefused,
  Content,
  CursorInvalid,
  Http,
  JobPermanent,
  JobRateLimited,
  JobRetryable,
  Log,
  Secrets,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import type { HttpResponse, ScheduleInput } from '@spaces/sdk'
import { calendarEvent, eventsPage, listUrl, mapEvent } from './events.ts'
import type { Mapped } from './events.ts'
import { manifest } from './manifest.ts'

/** A run that pages further than this is a provider bug, not a calendar. */
export const MAX_PAGES = 200

/** Google's reason for a 403 that is a quota, not a refusal. */
const QUOTA = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/

/**
 * A non-200 answer as the job's outcome.
 * - 410 on a sync token is `CursorInvalid`: the host clears the cursor and
 *   the next run starts again from `connectedAt`. On the bounded first pull
 *   it is Google's hiccup, and retryable.
 * - 401 is a revoked or expired grant: `ConnectionRefused`, which marks the
 *   connection in error and is never retried.
 */
const refused = (
  response: HttpResponse,
  resumed: boolean,
): Effect.Effect<
  never,
  | JobRetryable
  | JobRateLimited
  | JobPermanent
  | CursorInvalid
  | ConnectionRefused
> => {
  const { status } = response
  if (status === 410)
    return resumed
      ? Effect.fail(
          new CursorInvalid({ reason: 'Google expired the sync token' }),
        )
      : Effect.fail(
          new JobRetryable({ reason: 'Google answered 410 to a full list' }),
        )
  if (status === 429 || (status === 403 && QUOTA.test(response.body))) {
    const seconds = Number(response.headers['retry-after'] ?? '60')
    return Effect.fail(
      new JobRateLimited({
        reason: 'Google Calendar asked to slow down',
        retryAfterMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
      }),
    )
  }
  if (status >= 500)
    return Effect.fail(
      new JobRetryable({ reason: `Google Calendar answered ${status}` }),
    )
  if (status === 401)
    return Effect.fail(
      new ConnectionRefused({
        reason: 'Google refused the calendar connection: reconnect it',
      }),
    )
  return Effect.fail(
    new JobPermanent({ reason: `Google Calendar answered ${status}` }),
  )
}

/**
 * One sync: list the primary calendar from the stored sync token, or — the
 * first time, and after the token expired — from the connection's date, and
 * hand each event to `Content.logMeeting`, which decides what it is.
 * - Forward-only: nothing that ended before `connectedAt` is written, even
 *   when the change feed reports an edit to it.
 * - A page is written before the next is fetched; a run cut short re-reads
 *   it next time, and the meeting lane is keyed, so nothing doubles.
 */
export const sync = Effect.fn('googleCalendar.sync')(function* (
  input: ScheduleInput,
) {
  const { connectedAt } = input
  if (connectedAt === undefined) {
    return yield* new JobPermanent({
      reason:
        'the host gave no connectedAt, and a syncer never imports history',
    })
  }
  const token = yield* (yield* Secrets).accessToken().pipe(
    Effect.mapError(
      (e) =>
        new JobPermanent({
          reason: `Google Calendar is not connected: ${e.reason}`,
        }),
    ),
  )
  const http = yield* Http
  const content = yield* Content
  const log = yield* Log
  const from =
    input.cursor === null
      ? { timeMin: connectedAt }
      : { syncToken: input.cursor }
  const counts = { created: 0, updated: 0, refused: 0, skipped: 0 }
  let pageToken: string | undefined
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const url = listUrl(from, pageToken)
    const response = yield* http.request({
      method: 'GET',
      url,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${Redacted.value(token)}`,
      },
    })
    if (response.status !== 200)
      return yield* refused(response, input.cursor !== null)
    const page = eventsPage.safeParse(yield* responseJson(response, url))
    if (!page.success) {
      return yield* new JobPermanent({
        reason: 'Google Calendar returned a page this plugin cannot read',
      })
    }
    for (const item of page.data.items) {
      const event = calendarEvent.safeParse(item)
      const mapped: Mapped = event.success
        ? mapEvent(event.data, connectedAt)
        : { _tag: 'skip', reason: 'unreadable' }
      if (mapped._tag === 'skip') {
        counts.skipped++
        continue
      }
      const result = yield* content.logMeeting(mapped.claim)
      counts[result.outcome]++
    }
    if (page.data.nextPageToken !== undefined) {
      pageToken = page.data.nextPageToken
      continue
    }
    if (page.data.nextSyncToken === undefined) {
      return yield* new JobPermanent({
        reason: 'Google Calendar ended a list without a sync token',
      })
    }
    yield* log.info('synced', {
      from: 'syncToken' in from ? 'sync token' : `connectedAt ${connectedAt}`,
      ...counts,
    })
    return { nextCursor: page.data.nextSyncToken }
  }
  return yield* new JobPermanent({
    reason: `Google Calendar paged past ${MAX_PAGES} pages`,
  })
})

export const jobs = { sync }

export default definePlugin({ manifest, jobs })
