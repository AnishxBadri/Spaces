import { Effect, Redacted, Result } from 'effect'
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
import type {
  EmailResult,
  HttpResponse,
  JobError,
  ScheduleInput,
} from '@spaces/sdk'
import { z } from 'zod'
import { manifest } from './manifest.ts'
import {
  BATCH_SIZE,
  BOUNDARY,
  GMAIL_BATCH,
  PAGE_SIZE,
  batchBody,
  historyPage,
  isUserLabel,
  labelNames,
  labelsList,
  messagesPage,
  parseBatch,
  profile,
  rawMessage,
  url,
} from './messages.ts'
import type { RawMessage } from './messages.ts'

/** A run that pages further than this is a provider bug, not a mailbox. */
export const MAX_PAGES = 200

/** A 403 reason that is a quota: back off and try again. */
const QUOTA = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
])

/** A 403 reason that is the grant itself: no retry will change it. */
const REFUSAL = new Set([
  'insufficientPermissions',
  'accessNotConfigured',
  'domainPolicy',
  'authError',
])

type Failure =
  | JobRetryable
  | JobRateLimited
  | JobPermanent
  | CursorInvalid
  | ConnectionRefused

const envelope = z.object({
  error: z.object({
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
})

/** Google's error envelope: its words and its reasons; null when the body is not one. */
const googleError = (
  body: string,
): { words: string | null; reasons: Array<string> } | null => {
  try {
    const parsed = envelope.safeParse(JSON.parse(body))
    if (!parsed.success) return null
    return {
      words: parsed.data.error.message ?? null,
      reasons: (parsed.data.error.errors ?? []).flatMap((e) =>
        e.reason === undefined ? [] : [e.reason],
      ),
    }
  } catch {
    return null
  }
}

/**
 * A non-200 answer as the job's outcome — the taxonomy google-calendar
 * shares.
 * - 404 on a resumed history list is `CursorInvalid`: Gmail keeps about a
 *   week of history. The host clears the cursor and the next run starts
 *   again from `connectedAt`, never from the beginning of the mailbox.
 * - 401, and a 403 whose reason is the grant (`insufficientPermissions`,
 *   `accessNotConfigured`), is `ConnectionRefused`: the host marks the
 *   connection in error with Google's reason and never retries.
 * - 429 and a quota 403 wait out `Retry-After`; a 5xx, and a 403 whose
 *   reason is unknown or unreadable, is retried.
 */
const refused = (
  status: number,
  headers: { readonly [name: string]: string },
  body: string,
  history: boolean,
): Effect.Effect<never, Failure> => {
  if (status === 404 && history)
    return Effect.fail(
      new CursorInvalid({ reason: 'Gmail no longer holds that history id' }),
    )
  const google = googleError(body)
  const reasons = google?.reasons ?? []
  if (status === 429 || (status === 403 && reasons.some((r) => QUOTA.has(r)))) {
    const seconds = Number(headers['retry-after'] ?? '60')
    return Effect.fail(
      new JobRateLimited({
        reason: 'Gmail asked to slow down',
        retryAfterMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
      }),
    )
  }
  if (
    status === 401 ||
    (status === 403 && reasons.some((r) => REFUSAL.has(r)))
  ) {
    const words = google?.words ?? null
    return Effect.fail(
      new ConnectionRefused({
        reason: `Google refused the Gmail connection${words === null ? '' : ` (${words})`}: reconnect it`,
      }),
    )
  }
  if (status >= 500 || status === 403)
    return Effect.fail(new JobRetryable({ reason: `Gmail answered ${status}` }))
  return Effect.fail(new JobPermanent({ reason: `Gmail answered ${status}` }))
}

/** Labels whose mail is never the mailbox's conversation: Gmail's own bins. */
const NEVER_SYNCED = new Set(['SPAM', 'TRASH', 'DRAFT'])

const binned = (labelIds: ReadonlyArray<string>): boolean =>
  labelIds.some((id) => NEVER_SYNCED.has(id))

const unreadable = (what: string) =>
  new JobPermanent({ reason: `Gmail returned ${what} this plugin cannot read` })

/**
 * One sync. The first run — and the first after Gmail expired the history
 * id — takes the mailbox's current history id as its cursor, then lists the
 * mail received since `connectedAt`; every later run reads the history feed
 * from the cursor. Each new message's bytes come through the batch
 * endpoint and go to `Content.logEmail`, which decides what it is.
 * - Forward-only: nothing received before `connectedAt` is handed over,
 *   even when the history feed reports it; spam, trash and drafts never.
 * - One message the host cannot file is skipped and logged; a transient
 *   failure part-way through a resumed run keeps the history it reached.
 */
export const sync = Effect.fn('gmail.sync')(function* (input: ScheduleInput) {
  const { connectedAt } = input
  if (connectedAt === undefined) {
    return yield* new JobPermanent({
      reason:
        'the host gave no connectedAt, and a syncer never imports history',
    })
  }
  const floor = Date.parse(connectedAt)
  const token = yield* (yield* Secrets)
    .accessToken()
    .pipe(
      Effect.mapError(
        (e) =>
          new JobPermanent({ reason: `Gmail is not connected: ${e.reason}` }),
      ),
    )
  const http = yield* Http
  const content = yield* Content
  const log = yield* Log
  const authorization = `Bearer ${Redacted.value(token)}`

  const get = Effect.fn('gmail.get')(function* (
    target: string,
    history: boolean = false,
  ): Effect.fn.Return<unknown, Failure | JobError> {
    const response: HttpResponse = yield* http.request({
      method: 'GET',
      url: target,
      headers: { accept: 'application/json', authorization },
    })
    if (response.status !== 200)
      return yield* refused(
        response.status,
        response.headers,
        response.body,
        history,
      )
    return yield* responseJson(response, target)
  })

  const counts: Record<EmailResult['outcome'] | 'skipped', number> = {
    created: 0,
    duplicate: 0,
    refused: 0,
    skipped: 0,
  }

  // ---------- the ids to fetch, and the cursor the run ends on ----------
  // `through` is the history record a message arrived in: where a run cut
  // short may resume. The first run's list has none.
  const entries: Array<{ id: string; through: string | null }> = []
  let nextCursor: string
  if (input.cursor === null) {
    // The mailbox's own history id, taken before the list: never older than
    // Gmail's retention, and mail arriving mid-run is in the next history.
    const owner = profile.safeParse(yield* get(url('/users/me/profile')))
    if (!owner.success) return yield* unreadable('a profile')
    nextCursor = owner.data.historyId
    const ids: Array<string> = []
    let pageToken: string | undefined
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES)
        return yield* new JobPermanent({
          reason: `Gmail paged past ${MAX_PAGES} pages`,
        })
      const page = messagesPage.safeParse(
        yield* get(
          url('/users/me/messages', {
            q: `after:${Math.floor(floor / 1000)}`,
            maxResults: String(PAGE_SIZE),
            pageToken,
          }),
        ),
      )
      if (!page.success) return yield* unreadable('a message list')
      ids.push(...page.data.messages.map((m) => m.id))
      if (page.data.nextPageToken === undefined) break
      pageToken = page.data.nextPageToken
    }
    // Listed newest first; written oldest first, as they arrived.
    for (const id of ids.reverse()) entries.push({ id, through: null })
  } else {
    let pageToken: string | undefined
    let last = input.cursor
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES)
        return yield* new JobPermanent({
          reason: `Gmail paged past ${MAX_PAGES} pages`,
        })
      const page = historyPage.safeParse(
        yield* get(
          url('/users/me/history', {
            startHistoryId: input.cursor,
            historyTypes: 'messageAdded',
            maxResults: String(PAGE_SIZE),
            pageToken,
          }),
          true,
        ),
      )
      if (!page.success) return yield* unreadable('a history page')
      for (const record of page.data.history)
        for (const added of record.messagesAdded) {
          // The history feed reports spam, trash and drafts too; the
          // first run's list never sees them, and neither does this.
          if (binned(added.message.labelIds)) {
            counts.skipped++
            continue
          }
          if (!entries.some((e) => e.id === added.message.id))
            entries.push({ id: added.message.id, through: record.id })
        }
      last = page.data.historyId
      if (page.data.nextPageToken === undefined) break
      pageToken = page.data.nextPageToken
    }
    nextCursor = last
  }

  // ---------- user label names, once, when a message carries one ----------
  let userLabels: ReadonlyMap<string, string> | null = null
  const namesOf = Effect.fn('gmail.labels')(function* (
    message: RawMessage,
  ): Effect.fn.Return<Array<string>, Failure | JobError> {
    if (userLabels === null && message.labelIds.some(isUserLabel)) {
      const listed = labelsList.safeParse(yield* get(url('/users/me/labels')))
      if (!listed.success) return yield* unreadable('a label list')
      userLabels = new Map(listed.data.labels.map((l) => [l.id, l.name]))
    }
    return labelNames(message.labelIds, userLabels ?? new Map())
  })

  // ---------- the bytes, a batch at a time, each handed to the lane ----------
  /** The history record every message up to here was dealt with through. */
  const progress: { through: string | null } = { through: null }

  const fileOne = Effect.fn('gmail.fileOne')(function* (
    id: string,
    part: { readonly status: number; readonly body: string } | undefined,
  ): Effect.fn.Return<void, Failure | JobError> {
    if (part === undefined)
      return yield* new JobRetryable({
        reason: 'Gmail left a message out of a batch',
      })
    // Deleted between the list and the get: nothing to file.
    if (part.status === 404) {
      counts.skipped++
      return
    }
    if (part.status !== 200)
      return yield* refused(part.status, {}, part.body, false)
    const message = rawMessage.safeParse(
      yield* Effect.try({
        try: (): unknown => JSON.parse(part.body),
        catch: () => unreadable('a message'),
      }),
    )
    if (!message.success) return yield* unreadable('a message')
    const receivedAt = Number(message.data.internalDate)
    if (receivedAt < floor || binned(message.data.labelIds)) {
      counts.skipped++
      return
    }
    const labels = yield* namesOf(message.data)
    // One message the lane cannot file is skipped, in words, and the run
    // goes on: a message that always fails must not hold every later one.
    const result = yield* content
      .logEmail({
        _tag: 'email',
        providerMessageId: message.data.id,
        raw: message.data.raw,
        receivedAt: new Date(receivedAt).toISOString(),
        labels,
      })
      .pipe(
        Effect.catch((error) =>
          log
            .warn('skipped a message the host could not file', {
              id,
              reason: error.reason,
            })
            .pipe(Effect.as(null)),
        ),
      )
    if (result === null) counts.skipped++
    else counts[result.outcome]++
  })

  const fileBatch = Effect.fn('gmail.fileBatch')(function* (
    chunk: ReadonlyArray<{ id: string; through: string | null }>,
  ): Effect.fn.Return<void, Failure | JobError> {
    const response = yield* http.request({
      method: 'POST',
      url: GMAIL_BATCH,
      headers: {
        authorization,
        'content-type': `multipart/mixed; boundary=${BOUNDARY}`,
      },
      body: batchBody(chunk.map((e) => e.id)),
    })
    if (response.status !== 200)
      return yield* refused(
        response.status,
        response.headers,
        response.body,
        false,
      )
    const parts = parseBatch(
      response.headers['content-type'] ?? '',
      response.body,
    )
    if (parts === null) return yield* unreadable('a batch')
    for (let i = 0; i < chunk.length; i++) {
      const entry = chunk[i]
      yield* fileOne(
        entry.id,
        parts.find((p) => p.index === i),
      )
      if (entry.through !== null) progress.through = entry.through
    }
  })

  for (let at = 0; at < entries.length; at += BATCH_SIZE) {
    const outcome = yield* Effect.result(
      fileBatch(entries.slice(at, at + BATCH_SIZE)),
    )
    if (Result.isSuccess(outcome)) continue
    const error = outcome.failure
    // A transient failure part-way through keeps what was filed: the run
    // closes on the history record it reached, and the next resumes there.
    if (
      progress.through !== null &&
      (error._tag === 'JobRetryable' || error._tag === 'JobRateLimited')
    ) {
      yield* log.warn('stopped early; the next run resumes', {
        reason: error.reason,
        ...counts,
      })
      return { nextCursor: progress.through }
    }
    return yield* Effect.fail(error)
  }

  yield* log.info('synced', {
    from: input.cursor === null ? `connectedAt ${connectedAt}` : 'history',
    ...counts,
  })
  return { nextCursor }
})

export const jobs = { sync }

export default definePlugin({ manifest, jobs })
