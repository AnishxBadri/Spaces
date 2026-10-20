import { Clock, Effect, Redacted } from 'effect'
import {
  Content,
  Http,
  JobPermanent,
  JobRateLimited,
  JobRetryable,
  Log,
  OUTGOING_EMAIL_LIMIT_BYTES,
  Secrets,
  responseJson,
} from '@spaces/sdk'
import type {
  HttpResponse,
  JobError,
  OutgoingEmail,
  PayloadActionInput,
} from '@spaces/sdk'
import { z } from 'zod'
import { UPLOAD_BOUNDARY, buildMime, uploadBody } from './mime.ts'
import type { OutgoingAttachment } from './mime.ts'
import {
  GMAIL_SEND,
  QUOTA_REASONS,
  googleError,
  labelNames,
  messagesPage,
  rawMessage,
  sentRef,
  snippetText,
  url,
} from './messages.ts'

/**
 * Send: one message the host prepared (`OutgoingEmail`), built as MIME and
 * sent through `messages.send` with `gmail.send` (D66, D67).
 * - Threads: the parent's Gmail thread is found by its Message-ID, and the
 *   message carries `In-Reply-To` and `References` from the host.
 * - Idempotent by the host's Message-ID: a message the mailbox already
 *   holds under it is not sent again, only filed.
 * - The sent copy, as the mailbox keeps it, goes to `Content.logEmail`, so
 *   the outgoing row and a later sync land on one Message-ID. A copy the
 *   host cannot file is logged, never a failure: the mail is gone.
 * - A failure says what Gmail said; the host shows it and keeps the draft.
 */

const mailbox = z.object({
  email: z.string().min(3),
  name: z.string().exactOptional(),
})

const outgoing = z.object({
  messageId: z.string().regex(/^[^<>\s@]+@[^<>\s@]+$/),
  from: mailbox,
  to: z.array(mailbox),
  cc: z.array(mailbox),
  bcc: z.array(mailbox),
  subject: z.string(),
  bodyMd: z.string(),
  inReplyTo: z.string().min(1).nullable(),
  references: z.array(z.string().min(1)),
  attachments: z.array(
    z.object({
      filename: z.string().min(1),
      mime: z.string().min(1),
      url: z.url(),
      sizeBytes: z.int().nonnegative(),
    }),
  ),
}) satisfies z.ZodType<OutgoingEmail>

type Failure = JobRetryable | JobRateLimited | JobPermanent

const MB = 1024 * 1024

/** `26.2 MB`: one decimal, as the refusal names the total. */
const megabytes = (bytes: number): string =>
  `${(Math.round((bytes / MB) * 10) / 10).toFixed(1)} MB`

/** The refusal over the limit; `bytes` null when only the read found it. */
const tooLarge = (bytes: number | null) =>
  new JobPermanent({
    reason: `The files come to ${bytes === null ? 'more than 25 MB' : megabytes(bytes)}; Gmail sends 25 MB at most`,
  })

/** A non-200 from Gmail as the job's outcome, Google's own words kept. */
const refused = (response: HttpResponse): Failure => {
  const google = googleError(response.body)
  const words = google?.words ?? null
  const said = words === null ? '' : `: ${words}`
  const reasons = google?.reasons ?? []
  if (
    response.status === 429 ||
    (response.status === 403 && reasons.some((r) => QUOTA_REASONS.has(r)))
  ) {
    const seconds = Number(response.headers['retry-after'] ?? '60')
    return new JobRateLimited({
      reason: `Gmail asked to slow down${said}`,
      retryAfterMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
    })
  }
  if (response.status === 401 || response.status === 403)
    return new JobPermanent({
      reason: `Google refused to send through Gmail${said}. Reconnect Gmail`,
    })
  if (response.status >= 500)
    return new JobRetryable({
      reason: `Gmail answered ${String(response.status)}${said}`,
    })
  return new JobPermanent({
    reason: `Gmail refused the message (${String(response.status)})${said}`,
  })
}

/** A response stream read to its end, refused once it passes `limit`. */
const readAll = (
  body: ReadableStream<Uint8Array>,
  limit: number,
): Effect.Effect<Uint8Array | null, JobRetryable> =>
  Effect.tryPromise({
    try: async () => {
      const reader = body.getReader()
      const chunks: Array<Uint8Array> = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
      const out = new Uint8Array(size)
      let at = 0
      for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.byteLength
      }
      return out
    },
    catch: (error) =>
      new JobRetryable({
        reason: `A file could not be read: ${String(error)}`,
      }),
  })

export const send = Effect.fn('gmail.send')(function* (
  input: PayloadActionInput,
) {
  const parsed = outgoing.safeParse(input.payload)
  if (!parsed.success)
    return yield* new JobPermanent({
      reason: 'the host sent a message the send job cannot read',
    })
  const message = parsed.data
  const declared = message.attachments.reduce((n, a) => n + a.sizeBytes, 0)
  if (declared > OUTGOING_EMAIL_LIMIT_BYTES) return yield* tooLarge(declared)

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

  const get = Effect.fn('gmail.send.get')(function* (
    target: string,
  ): Effect.fn.Return<unknown, Failure | JobError> {
    const response = yield* http.request({
      method: 'GET',
      url: target,
      headers: { accept: 'application/json', authorization },
    })
    if (response.status !== 200) return yield* refused(response)
    return yield* responseJson(response, target)
  })

  /** The mailbox's message under an RFC Message-ID, or null. */
  const byMessageId = Effect.fn('gmail.send.byMessageId')(function* (
    id: string,
  ) {
    const page = messagesPage.safeParse(
      yield* get(
        url('/users/me/messages', {
          q: `rfc822msgid:${id}`,
          maxResults: '1',
        }),
      ),
    )
    return page.success ? (page.data.messages.at(0) ?? null) : null
  })

  const held = yield* byMessageId(message.messageId)
  let gmailId: string
  if (held !== null) {
    yield* log.info('already in the mailbox; not sent again', {
      messageId: message.messageId,
    })
    gmailId = held.id
  } else {
    const parent =
      message.inReplyTo === null ? null : yield* byMessageId(message.inReplyTo)

    const files: Array<OutgoingAttachment> = []
    let total = 0
    for (const file of message.attachments) {
      const response = yield* http.stream({ method: 'GET', url: file.url })
      if (response.status !== 200) {
        yield* Effect.promise(() => response.body.cancel())
        return yield* new JobRetryable({
          reason: `${file.filename} could not be read (${String(response.status)})`,
        })
      }
      const bytes = yield* readAll(
        response.body,
        OUTGOING_EMAIL_LIMIT_BYTES - total,
      )
      if (bytes === null) return yield* tooLarge(null)
      total += bytes.byteLength
      files.push({ filename: file.filename, mime: file.mime, bytes })
    }

    const now = yield* Clock.currentTimeMillis
    const raw = buildMime({
      messageId: message.messageId,
      date: new Date(now),
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      bodyMd: message.bodyMd,
      inReplyTo: message.inReplyTo,
      references: message.references,
      attachments: files,
    })
    const response = yield* http.request({
      method: 'POST',
      url: GMAIL_SEND,
      headers: {
        authorization,
        'content-type': `multipart/related; boundary=${UPLOAD_BOUNDARY}`,
      },
      body: uploadBody(raw, parent?.threadId ?? null),
    })
    if (response.status !== 200) return yield* refused(response)
    const sent = sentRef.safeParse(yield* responseJson(response, GMAIL_SEND))
    if (!sent.success)
      return yield* new JobPermanent({
        reason: 'Gmail sent the message but answered without its id',
      })
    gmailId = sent.data.id
  }

  // The sent copy as the mailbox holds it. Unreadable, the message is
  // still sent: the next sync files it.
  const copy = rawMessage.safeParse(
    yield* get(
      url(`/users/me/messages/${encodeURIComponent(gmailId)}`, {
        format: 'raw',
      }),
    ).pipe(Effect.orElseSucceed(() => null)),
  )
  if (!copy.success) {
    yield* log.warn('sent; the mailbox copy could not be read', {
      messageId: message.messageId,
    })
    return
  }
  const snippet = snippetText(copy.data.snippet)
  const filed = yield* content
    .logEmail({
      _tag: 'email',
      providerMessageId: copy.data.id,
      raw: copy.data.raw,
      receivedAt: new Date(Number(copy.data.internalDate)).toISOString(),
      labels: labelNames(copy.data.labelIds, new Map()),
      ...(snippet === undefined ? {} : { snippet }),
    })
    .pipe(
      Effect.catch((error) =>
        log
          .warn('sent; the host could not file it', {
            messageId: message.messageId,
            reason: error.reason,
          })
          .pipe(Effect.as(null)),
      ),
    )
  yield* log.info('sent', {
    messageId: message.messageId,
    outcome: filed?.outcome ?? 'unfiled',
  })
})
