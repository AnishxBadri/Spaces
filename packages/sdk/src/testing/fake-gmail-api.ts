import type { JsonValue } from '../contract.ts'
import type { FetchLike } from './fake-drive-api.ts'

/**
 * Gmail's v1 API, in process: a `fetch`-shaped function a syncer's real
 * HTTP code runs against — `messages.list` with `after:`, `messages.get`,
 * `history.list`, `labels.list`, `getProfile` and the batch endpoint — with
 * toggles for the bad days (`expireHistory`, `rateLimit`, `revoke`).
 *
 * - Every request is recorded with its path and query, a batch's inner
 *   requests included, so a test asserts what was sent.
 * - `messages.list` without `q` lists the whole mailbox, newest first — the
 *   full-history import a forward-only syncer must never page through. Spam
 *   and trash are left out unless `includeSpamTrash`, as Gmail's are; the
 *   history feed reports every addition, theirs included.
 * - A history id older than the oldest kept answers 404, as Gmail's does.
 * - `deliver` is mail arriving after the connection; it reads as added to
 *   every older history id.
 */

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

/** The batch endpoint: one multipart/mixed POST, up to 100 GETs inside. */
export const GMAIL_BATCH = 'https://gmail.googleapis.com/batch/gmail/v1'

/** The connected mailbox's owner: the demo workspace's own address. */
export const FAKE_GMAIL_OWNER = 'anish@fund.example'

/** The bearer token the fake accepts unless given another. */
export const FAKE_GMAIL_TOKEN = 'fake-gmail-token'

/** One part of a message the fake builds: a file attached to it. */
export type FakeGmailAttachment = {
  readonly filename: string
  readonly mime: string
  /** The part's bytes, as text; the fake base64-encodes them. */
  readonly content: string
}

/** A message as a test writes it; the fake renders the RFC 5322 bytes. */
export type FakeGmailMessage = {
  readonly id: string
  readonly threadId?: string
  /** Gmail's label ids: `INBOX`, `SENT`, `CATEGORY_PROMOTIONS`, `Label_1`. */
  readonly labelIds: ReadonlyArray<string>
  /** When the mailbox received it, epoch ms. */
  readonly receivedAt: number
  /** Without angle brackets; absent writes no Message-ID header. */
  readonly messageId?: string
  readonly from: string
  readonly to: ReadonlyArray<string>
  readonly cc?: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  /** Extra headers, written as given (`List-Unsubscribe`, `Auto-Submitted`). */
  readonly headers?: { readonly [name: string]: string }
  readonly attachments?: ReadonlyArray<FakeGmailAttachment>
}

/** A label `labels.list` answers. */
export type FakeGmailLabel = {
  readonly id: string
  readonly name: string
  readonly type: 'system' | 'user'
}

/** One request the fake received. `path` is relative to `GMAIL_API`. */
export type GmailApiRequest = {
  readonly method: string
  readonly path: string
  /** A parameter the request did not send reads as undefined. */
  readonly query: { readonly [name: string]: string | undefined }
  /** True for a GET that arrived inside a batch. */
  readonly batched: boolean
}

export type FakeGmailApi = {
  readonly fetch: FetchLike
  readonly requests: ReadonlyArray<GmailApiRequest>
  readonly accessToken: string
  /** Mail arriving now: stored with the next history id. */
  readonly deliver: (message: FakeGmailMessage) => void
  readonly messages: () => ReadonlyArray<FakeGmailMessage>
  /** The mailbox's current history id. */
  readonly historyId: () => number
  /** Every history id issued so far answers 404 from now on. */
  readonly expireHistory: () => void
  /** The next `times` requests answer 429 with this `Retry-After`, in seconds. */
  readonly rateLimit: (times: number, retryAfterSeconds: number) => void
  /** The token is revoked: every later request is a 401. */
  readonly revoke: () => void
}

export type FakeGmailApiOptions = {
  /** The mailbox; `fakeGmailSeed` when absent. */
  readonly seed?: ReadonlyArray<FakeGmailMessage>
  /** The instant the default seed is laid out around; `Date.now()` when absent. */
  readonly now?: number
  readonly accessToken?: string
  readonly labels?: ReadonlyArray<FakeGmailLabel>
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Gmail's system and category labels, and one user label. */
export const FAKE_GMAIL_LABELS: ReadonlyArray<FakeGmailLabel> = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'SENT', name: 'SENT', type: 'system' },
  { id: 'UNREAD', name: 'UNREAD', type: 'system' },
  { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', type: 'system' },
  { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system' },
  { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
  { id: 'CATEGORY_UPDATES', name: 'CATEGORY_UPDATES', type: 'system' },
  { id: 'CATEGORY_FORUMS', name: 'CATEGORY_FORUMS', type: 'system' },
  { id: 'Label_1', name: 'Recruiting', type: 'user' },
]

/** The PDF-ish bytes the seed's deck attachment carries. */
export const FAKE_GMAIL_DECK = '%PDF-1.4\nAcme Robotics Q3 board deck\n%%EOF\n'

/**
 * The demo mailbox, laid out around `now`: a year of history before an
 * hour ago, which a forward-only sync never imports, then the last half
 * hour — an update from Acme with its deck, an intro from Gamma, a
 * promotion, a `noreply@` notice, a newsletter and a reply the owner sent.
 * The workspace is `fund.example`.
 */
export const fakeGmailSeed = (now: number): Array<FakeGmailMessage> => [
  {
    id: 'm-old-acme',
    labelIds: ['INBOX'],
    receivedAt: now - 365 * DAY,
    messageId: 'board-2025@acme-robotics.example',
    from: 'Jane Founder <jane@acme-robotics.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Acme board pack, last year',
    body: 'Last year’s board pack.',
  },
  {
    id: 'm-old-beta',
    labelIds: ['INBOX'],
    receivedAt: now - 200 * DAY,
    messageId: 'intro@betalabs.example',
    from: 'Sam Beta <sam@betalabs.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Beta Labs intro',
    body: 'Hello from Beta Labs.',
  },
  {
    id: 'm-old-gamma',
    labelIds: ['INBOX'],
    receivedAt: now - 30 * DAY,
    messageId: 'gamma-old@gamma.example',
    from: 'Lee Gamma <lee@gamma.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Gamma, a month ago',
    body: 'An older Gamma note.',
  },
  {
    id: 'm-old-hours',
    labelIds: ['INBOX'],
    receivedAt: now - 2 * HOUR,
    messageId: 'before-connect@acme-robotics.example',
    from: 'Jane Founder <jane@acme-robotics.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Just before you connected',
    body: 'Sent two hours ago.',
  },
  {
    id: 'm-acme-update',
    labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
    receivedAt: now - 30 * MINUTE,
    messageId: 'acme-q3@acme-robotics.example',
    from: 'Jane Founder <jane@acme-robotics.example>',
    to: [FAKE_GMAIL_OWNER],
    cc: ['Acme CFO <cfo@acme-robotics.example>'],
    subject: 'Acme Robotics — Q3 update',
    body: 'Q3 closed ahead of plan. The flywheel-margin story is in the deck.',
    attachments: [
      {
        filename: 'acme-q3.pdf',
        mime: 'application/pdf',
        content: FAKE_GMAIL_DECK,
      },
    ],
  },
  {
    id: 'm-gamma-intro',
    labelIds: ['INBOX'],
    receivedAt: now - 25 * MINUTE,
    messageId: 'gamma-intro@gamma.example',
    from: 'Lee Gamma <lee@gamma.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Gamma — intro',
    body: 'Would love twenty minutes next week.',
  },
  {
    id: 'm-promo',
    labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
    receivedAt: now - 20 * MINUTE,
    messageId: 'sale@shopstuff.example',
    from: 'Shop Stuff <deals@shopstuff.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Everything 30% off',
    body: 'Do not miss out.',
  },
  {
    id: 'm-noreply',
    labelIds: ['INBOX'],
    receivedAt: now - 15 * MINUTE,
    messageId: 'receipt@saas.example',
    from: 'SaaS <noreply@saas.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Your receipt',
    body: 'Thanks for your payment.',
  },
  {
    id: 'm-newsletter',
    labelIds: ['INBOX'],
    receivedAt: now - 10 * MINUTE,
    messageId: 'issue-42@newsletter.example',
    from: 'The Editor <editor@newsletter.example>',
    to: [FAKE_GMAIL_OWNER],
    subject: 'Issue 42',
    body: 'This week in venture.',
    headers: { 'List-Unsubscribe': '<mailto:leave@newsletter.example>' },
  },
  {
    id: 'm-sent',
    labelIds: ['SENT'],
    receivedAt: now - 5 * MINUTE,
    messageId: 'next-steps@fund.example',
    from: `Anish <${FAKE_GMAIL_OWNER}>`,
    to: ['Kim Delta <kim@delta.example>'],
    subject: 'Delta — next steps',
    body: 'Great meeting. Sending the term sheet this week.',
  },
]

// ---------------------------------------------------------------------------
// RFC 5322 bytes and base64url
// ---------------------------------------------------------------------------

const base64OfBytes = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** UTF-8 text → base64url without padding, as Gmail's `raw` is spelled. */
export const base64Url = (text: string): string =>
  base64OfBytes(new TextEncoder().encode(text))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

/** A base64url `raw` → its text. */
export const fromBase64Url = (raw: string): string => {
  const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** The base64 of text, wrapped at 76 columns as MIME writes it. */
const wrapped = (text: string): string =>
  (base64OfBytes(new TextEncoder().encode(text)).match(/.{1,76}/g) ?? []).join(
    '\r\n',
  )

/** The message's RFC 5322 text: headers, then a body or a multipart/mixed. */
export const renderMessage = (message: FakeGmailMessage): string => {
  const head = [
    ...(message.messageId === undefined
      ? []
      : [`Message-ID: <${message.messageId}>`]),
    `Date: ${new Date(message.receivedAt).toUTCString()}`,
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc === undefined || message.cc.length === 0
      ? []
      : [`Cc: ${message.cc.join(', ')}`]),
    `Subject: ${message.subject}`,
    ...Object.entries(message.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
  ]
  const attachments = message.attachments ?? []
  if (attachments.length === 0)
    return [
      ...head,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapped(message.body),
      '',
    ].join('\r\n')
  const boundary = `fake-${message.id}`
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(message.body),
    ...attachments.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: ${a.mime}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapped(a.content),
    ]),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

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
const gmailError = (
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

const STATUS_TEXT: { readonly [status: number]: string } = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  429: 'Too Many Requests',
}

type Stored = { message: FakeGmailMessage; historyId: number }

type Routed = { status: number; body: JsonValue }

const AFTER = /^after:(\d+)$/
const MESSAGE = /^\/users\/me\/messages\/([^/]+)$/
const PAGE_TOKEN = /^page-(\d+)$/

export const makeFakeGmailApi = (
  options: FakeGmailApiOptions = {},
): FakeGmailApi => {
  const accessToken = options.accessToken ?? FAKE_GMAIL_TOKEN
  const labels = options.labels ?? FAKE_GMAIL_LABELS
  const stored = new Map<string, Stored>()
  const requests: Array<GmailApiRequest> = []
  let history = 1000
  let floor = 0
  let revoked = false
  let limited = { times: 0, retryAfter: 1 }

  const deliver = (message: FakeGmailMessage) => {
    stored.set(message.id, { message, historyId: ++history })
  }
  for (const message of [
    ...(options.seed ?? fakeGmailSeed(options.now ?? Date.now())),
  ].sort((a, b) => a.receivedAt - b.receivedAt))
    deliver(message)

  const resource = (s: Stored, format: string): JsonValue => {
    const raw = renderMessage(s.message)
    return {
      id: s.message.id,
      threadId: s.message.threadId ?? s.message.id,
      labelIds: [...s.message.labelIds],
      snippet: s.message.body.slice(0, 80),
      historyId: String(s.historyId),
      internalDate: String(s.message.receivedAt),
      sizeEstimate: raw.length,
      ...(format === 'raw' ? { raw: base64Url(raw) } : {}),
    }
  }

  const offsetOf = (token: string | undefined): number =>
    token === undefined ? 0 : Number(PAGE_TOKEN.exec(token)?.[1] ?? Number.NaN)

  const route = (
    path: string,
    query: { readonly [name: string]: string | undefined },
  ): Routed => {
    if (path === '/users/me/profile')
      return {
        status: 200,
        body: {
          emailAddress: FAKE_GMAIL_OWNER,
          messagesTotal: stored.size,
          historyId: String(history),
        },
      }
    if (path === '/users/me/labels')
      return {
        status: 200,
        body: { labels: labels.map((l) => ({ ...l })) },
      }
    if (path === '/users/me/messages') {
      let after: number | null = null
      if (query.q !== undefined) {
        const parsed = AFTER.exec(query.q.trim())
        if (parsed === null)
          return {
            status: 400,
            body: {
              error: {
                code: 400,
                message: 'The fake reads after:<seconds> only.',
              },
            },
          }
        after = Number(parsed[1]) * 1000
      }
      const bins = query.includeSpamTrash === 'true' ? [] : ['SPAM', 'TRASH']
      const matching = [...stored.values()]
        .filter((s) => after === null || s.message.receivedAt > after)
        .filter((s) => !s.message.labelIds.some((id) => bins.includes(id)))
        .sort((a, b) => b.message.receivedAt - a.message.receivedAt)
      const offset = offsetOf(query.pageToken)
      if (Number.isNaN(offset))
        return {
          status: 400,
          body: { error: { code: 400, message: 'Bad pageToken.' } },
        }
      const size = Math.min(500, Number(query.maxResults ?? '100'))
      const page = matching.slice(offset, offset + size)
      return {
        status: 200,
        body: {
          ...(page.length === 0
            ? {}
            : {
                messages: page.map((s) => ({
                  id: s.message.id,
                  threadId: s.message.threadId ?? s.message.id,
                })),
              }),
          ...(offset + size < matching.length
            ? { nextPageToken: `page-${offset + size}` }
            : {}),
          resultSizeEstimate: matching.length,
        },
      }
    }
    const messageId = MESSAGE.exec(path)?.[1]
    if (messageId !== undefined) {
      const held = stored.get(decodeURIComponent(messageId))
      return held === undefined
        ? {
            status: 404,
            body: {
              error: { code: 404, message: 'Requested entity was not found.' },
            },
          }
        : { status: 200, body: resource(held, query.format ?? 'full') }
    }
    if (path === '/users/me/history') {
      const start = Number(query.startHistoryId)
      if (!Number.isInteger(start) || start <= floor)
        return {
          status: 404,
          body: {
            error: { code: 404, message: 'Requested entity was not found.' },
          },
        }
      const added = [...stored.values()]
        .filter((s) => s.historyId > start)
        .sort((a, b) => a.historyId - b.historyId)
      const offset = offsetOf(query.pageToken)
      const size = Math.min(500, Number(query.maxResults ?? '100'))
      const page = added.slice(offset, offset + size)
      return {
        status: 200,
        body: {
          ...(page.length === 0
            ? {}
            : {
                history: page.map((s) => ({
                  id: String(s.historyId),
                  messagesAdded: [
                    {
                      message: {
                        id: s.message.id,
                        threadId: s.message.threadId ?? s.message.id,
                        labelIds: [...s.message.labelIds],
                      },
                    },
                  ],
                })),
              }),
          ...(offset + size < added.length
            ? { nextPageToken: `page-${offset + size}` }
            : {}),
          historyId: String(history),
        },
      }
    }
    return {
      status: 404,
      body: { error: { code: 404, message: `${path} is not served` } },
    }
  }

  const record = (method: string, url: URL, batched: boolean) => {
    const query: { [name: string]: string } = {}
    url.searchParams.forEach((value, name) => {
      query[name] = value
    })
    const path = url.pathname.startsWith('/gmail/v1')
      ? url.pathname.slice('/gmail/v1'.length)
      : url.pathname
    requests.push({ method, path, query, batched })
    return { path, query }
  }

  /** One batch: each part an `application/http` GET, answered in kind. */
  const batch = (contentType: string, body: string): Response => {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1]
    if (boundary === undefined)
      return gmailError(
        400,
        'badRequest',
        'A batch needs a multipart boundary.',
      )
    const parts = body
      .split(`--${boundary}`)
      .slice(1)
      .filter((p) => !p.startsWith('--'))
    if (parts.length > 100)
      return gmailError(
        400,
        'badRequest',
        'A batch holds 100 requests at most.',
      )
    const out = 'batch_fake_response'
    const answers = parts.map((part) => {
      const contentId = /content-id:\s*<?([^>\r\n]+)>?/i.exec(part)?.[1] ?? ''
      const line = /^(GET|POST) (\S+)(?: HTTP\/1\.1)?\r?$/m.exec(part)
      const routed: Routed =
        line === null
          ? {
              status: 400,
              body: { error: { code: 400, message: 'Unreadable part.' } },
            }
          : line[1] !== 'GET'
            ? {
                status: 400,
                body: {
                  error: { code: 400, message: 'The fake batches GETs only.' },
                },
              }
            : (() => {
                const inner = record(
                  'GET',
                  new URL(line[2], 'https://gmail.googleapis.com'),
                  true,
                )
                return route(inner.path, inner.query)
              })()
      return [
        `--${out}`,
        'Content-Type: application/http',
        `Content-ID: <response-${contentId}>`,
        '',
        `HTTP/1.1 ${routed.status} ${STATUS_TEXT[routed.status] ?? 'Error'}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(routed.body),
      ].join('\r\n')
    })
    return new Response([...answers, `--${out}--`, ''].join('\r\n'), {
      status: 200,
      headers: { 'content-type': `multipart/mixed; boundary=${out}` },
    })
  }

  const fetch: FetchLike = (url, init) => {
    const parsed = new URL(url)
    const isBatch = `${parsed.origin}${parsed.pathname}` === GMAIL_BATCH
    const isApi = `${parsed.origin}${parsed.pathname}`.startsWith(GMAIL_API)
    if (!isBatch) record(init.method, parsed, false)
    else
      requests.push({
        method: init.method,
        path: '/batch',
        query: {},
        batched: false,
      })
    if (!isBatch && !isApi)
      return Promise.resolve(
        gmailError(404, 'notFound', `${url} is not the Gmail API`),
      )
    const header = (name: string) =>
      Object.entries(init.headers).find(
        ([key]) => key.toLowerCase() === name,
      )?.[1]
    if (revoked || header('authorization') !== `Bearer ${accessToken}`)
      return Promise.resolve(
        gmailError(401, 'authError', 'Invalid Credentials'),
      )
    if (limited.times > 0) {
      limited = { ...limited, times: limited.times - 1 }
      return Promise.resolve(
        gmailError(429, 'rateLimitExceeded', 'Rate Limit Exceeded', {
          'retry-after': String(limited.retryAfter),
        }),
      )
    }
    if (isBatch) {
      if (init.method !== 'POST' || typeof init.body !== 'string')
        return Promise.resolve(
          gmailError(400, 'badRequest', 'A batch is a POST with a text body.'),
        )
      return Promise.resolve(batch(header('content-type') ?? '', init.body))
    }
    if (init.method !== 'GET')
      return Promise.resolve(
        gmailError(404, 'notFound', `${init.method} is not served`),
      )
    const last = requests.at(-1)
    const routed = route(last?.path ?? '', last?.query ?? {})
    return Promise.resolve(json(routed.status, routed.body))
  }

  return {
    fetch,
    requests,
    accessToken,
    deliver,
    messages: () => [...stored.values()].map((s) => s.message),
    historyId: () => history,
    expireHistory: () => {
      floor = history
    },
    rateLimit: (times, retryAfterSeconds) => {
      limited = { times, retryAfter: retryAfterSeconds }
    },
    revoke: () => {
      revoked = true
    },
  }
}
