import { Cause, Effect, Exit, Layer } from 'effect'
import { Content, JobRetryable } from '@spaces/sdk'
import type { EmailClaim } from '@spaces/sdk'
import {
  ContentTest,
  FAKE_GMAIL_OWNER,
  HttpFetchTest,
  LogTest,
  SecretsTest,
  fromBase64Url,
  makeFakeGmailApi,
} from '@spaces/sdk/testing'
import type {
  FakeGmailApi,
  FakeGmailMessage,
  FetchLike,
} from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.ts'
import { batchBody, parseBatch } from './messages.ts'

/**
 * The sync job against the in-repo fake of Gmail: no network, no Google
 * project. The fake's demo mailbox holds a year of history before an hour
 * ago and the last half hour's mail, laid out around `NOW`; the connection
 * was made at `CONNECTED`, an hour ago.
 */
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const CONNECTED = '2026-10-10T11:00:00.000Z'

const harness = (
  api: FakeGmailApi = makeFakeGmailApi({ now: NOW }),
  fetch: FetchLike = api.fetch,
) => {
  const content = ContentTest()
  const log = LogTest()
  const layer = Layer.mergeAll(
    HttpFetchTest(fetch).layer,
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
  const claims = () => content.calls.map((c) => c.input).filter(isEmail)
  const ids = () => claims().map((c) => c.providerMessageId)
  return { api, content, log, run, ok, claims, ids }
}

const isEmail = (x: unknown): x is EmailClaim =>
  typeof x === 'object' && x !== null && '_tag' in x && x._tag === 'email'

const failureOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null

const AFTER_CONNECT = [
  'm-acme-update',
  'm-gamma-intro',
  'm-promo',
  'm-noreply',
  'm-newsletter',
  'm-sent',
]

describe('the first run', () => {
  it('takes the mailbox’s history id, lists from the connection on, and hands over nothing older', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    expect(cursor).toBe(String(h.api.historyId()))
    expect(h.api.requests.at(0)?.path).toBe('/users/me/profile')
    const lists = h.api.requests.filter((r) => r.path === '/users/me/messages')
    // Only the bounded list: never the unbounded one.
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.every((r) => r.query.q?.startsWith('after:'))).toBe(true)
    expect(lists.at(0)?.query.q).toBe(
      `after:${Math.floor(Date.parse(CONNECTED) / 1000)}`,
    )
    // Oldest first; every one fetched through the batch endpoint.
    expect(h.ids()).toEqual(AFTER_CONNECT)
    expect(
      h.api.requests.filter((r) => r.batched).map((r) => r.query.format),
    ).toEqual(AFTER_CONNECT.map(() => 'raw'))
    for (const claim of h.claims())
      expect(Date.parse(claim.receivedAt)).toBeGreaterThanOrEqual(
        Date.parse(CONNECTED),
      )
  })

  it('hands over the bytes whole, with label names the host can exclude by', async () => {
    const h = harness()
    await h.ok(null)
    const acme = h.claims().find((c) => c.providerMessageId === 'm-acme-update')
    expect(fromBase64Url(acme?.raw ?? '')).toContain(
      'Message-ID: <acme-q3@acme-robotics.example>',
    )
    expect(fromBase64Url(acme?.raw ?? '')).toContain('acme-q3.pdf')
    expect(acme?.labels).toEqual(['Inbox', 'Primary'])
    const promo = h.claims().find((c) => c.providerMessageId === 'm-promo')
    expect(promo?.labels).toEqual(['Inbox', 'Promotions'])
    // No claim field says who may read the body: that is the host's.
    expect(Object.keys(acme ?? {}).sort()).toEqual([
      '_tag',
      'labels',
      'providerMessageId',
      'raw',
      'receivedAt',
    ])
  })

  it('names a user label through labels.list, asked once', async () => {
    const api = makeFakeGmailApi({ now: NOW, seed: [] })
    api.deliver({
      id: 'm-recruit',
      labelIds: ['INBOX', 'Label_1'],
      receivedAt: NOW,
      messageId: 'recruit@candidate.example',
      from: 'Cand <cand@candidate.example>',
      to: [FAKE_GMAIL_OWNER],
      subject: 'Role',
      body: 'Hi',
    })
    const h = harness(api)
    await h.ok(null)
    expect(h.claims().at(0)?.labels).toEqual(['Inbox', 'Recruiting'])
    expect(
      api.requests.filter((r) => r.path === '/users/me/labels'),
    ).toHaveLength(1)
  })

  it('takes an empty mailbox’s cursor from the profile', async () => {
    const h = harness(makeFakeGmailApi({ now: NOW, seed: [] }))
    expect(await h.ok(null)).toBe(String(h.api.historyId()))
    expect(h.claims()).toEqual([])
  })
})

describe('later runs', () => {
  it('read the history feed from the cursor and hand over only what arrived', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const before = h.claims().length
    expect(await h.ok(cursor)).toBe(cursor)
    expect(h.claims()).toHaveLength(before)
    h.api.deliver({
      id: 'm-new',
      labelIds: ['INBOX'],
      receivedAt: NOW + 60_000,
      messageId: 'new@acme-robotics.example',
      from: 'Jane Founder <jane@acme-robotics.example>',
      to: [FAKE_GMAIL_OWNER],
      subject: 'One more thing',
      body: 'Forgot the cap table.',
    })
    const next = await h.ok(cursor)
    expect(next).toBe(String(h.api.historyId()))
    expect(h.ids().slice(before)).toEqual(['m-new'])
    expect(h.api.requests.at(-3)?.query).toMatchObject({
      startHistoryId: cursor,
      historyTypes: 'messageAdded',
    })
  })

  it('skip mail the history feed reports from before the connection', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const before = h.claims().length
    h.api.deliver({
      id: 'm-late-old',
      labelIds: ['INBOX'],
      receivedAt: Date.parse(CONNECTED) - 86_400_000,
      messageId: 'imported-late@acme-robotics.example',
      from: 'Jane Founder <jane@acme-robotics.example>',
      to: [FAKE_GMAIL_OWNER],
      subject: 'Restored from an archive',
      body: 'Old.',
    })
    await h.ok(cursor)
    expect(h.claims()).toHaveLength(before)
  })

  it('answer an expired history id with CursorInvalid, never a full list', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    h.api.expireHistory()
    const exit = await h.run(cursor)
    expect(failureOf(exit)).toMatchObject({ _tag: 'CursorInvalid' })
    // The host clears the cursor; the next run is the bounded first run.
    await h.ok(null)
    const lists = h.api.requests.filter((r) => r.path === '/users/me/messages')
    expect(lists.every((r) => r.query.q?.startsWith('after:'))).toBe(true)
  })
})

describe('the bad days', () => {
  it('waits out a 429 with its Retry-After', async () => {
    const h = harness()
    h.api.rateLimit(1, 30)
    const exit = await h.run(null)
    expect(failureOf(exit)).toMatchObject({
      _tag: 'JobRateLimited',
      retryAfterMs: 30_000,
    })
  })

  it('answers a revoked grant with ConnectionRefused, in Google’s words', async () => {
    const h = harness()
    h.api.revoke()
    const exit = await h.run(null)
    expect(failureOf(exit)).toMatchObject({
      _tag: 'ConnectionRefused',
      reason:
        'Google refused the Gmail connection (Invalid Credentials): reconnect it',
    })
    expect(h.claims()).toEqual([])
  })

  it('refuses to run without connectedAt', async () => {
    const h = harness()
    const exit = await Effect.runPromiseExit(
      plugin.jobs
        .sync({ cursor: null })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              HttpFetchTest(h.api.fetch).layer,
              SecretsTest({ accessToken: h.api.accessToken }).layer,
              h.content.layer,
              h.log.layer,
            ),
          ),
        ),
    )
    expect(failureOf(exit)).toMatchObject({ _tag: 'JobPermanent' })
    expect(h.api.requests).toEqual([])
  })
})

describe('the batch wire format', () => {
  it('reads back what it writes, by index, whatever the order', () => {
    const body = batchBody(['a', 'b'])
    expect(body).toContain('GET /gmail/v1/users/me/messages/a?format=raw')
    const response = [
      '--r',
      'Content-Type: application/http',
      'Content-ID: <response-item-1>',
      '',
      'HTTP/1.1 404 Not Found',
      'Content-Type: application/json',
      '',
      '{"error":{}}',
      '--r',
      'Content-Type: application/http',
      'Content-ID: <response-item-0>',
      '',
      'HTTP/1.1 200 OK',
      'Content-Type: application/json',
      '',
      '{"id":"a"}',
      '--r--',
    ].join('\r\n')
    expect(parseBatch('multipart/mixed; boundary=r', response)).toEqual([
      { index: 1, status: 404, body: '{"error":{}}' },
      { index: 0, status: 200, body: '{"id":"a"}' },
    ])
    expect(parseBatch('application/json', response)).toBeNull()
  })
})

const later = (
  id: string,
  at: number,
  extra: Partial<FakeGmailMessage> = {},
): FakeGmailMessage => ({
  id,
  labelIds: ['INBOX'],
  receivedAt: at,
  messageId: `${id}@acme-robotics.example`,
  from: 'Jane Founder <jane@acme-robotics.example>',
  to: [FAKE_GMAIL_OWNER],
  subject: id,
  body: 'More news.',
  ...extra,
})

describe('what the history feed reports that is not conversation', () => {
  it('skips spam, trash and drafts without fetching them', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const before = h.claims().length
    h.api.deliver(later('m-spam', NOW + 1_000, { labelIds: ['SPAM'] }))
    h.api.deliver(later('m-trash', NOW + 2_000, { labelIds: ['TRASH'] }))
    h.api.deliver(
      later('m-draft', NOW + 3_000, {
        labelIds: ['DRAFT'],
        from: `Anish <${FAKE_GMAIL_OWNER}>`,
        to: ['kim@delta.example'],
      }),
    )
    h.api.deliver(later('m-real', NOW + 4_000))
    await h.ok(cursor)
    expect(h.ids().slice(before)).toEqual(['m-real'])
    const fetched = h.api.requests.filter((r) => r.batched).map((r) => r.path)
    for (const id of ['m-spam', 'm-trash', 'm-draft'])
      expect(fetched).not.toContain(`/users/me/messages/${id}`)
  })
})

describe('a 403', () => {
  /** The profile answers 403 with `body` once; everything else is the fake's. */
  const forbidding =
    (api: FakeGmailApi, body: string): FetchLike =>
    (url, init) =>
      url.includes('/users/me/profile')
        ? Promise.resolve(
            new Response(body, {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : api.fetch(url, init)
  const google = (reason: string) =>
    JSON.stringify({
      error: {
        code: 403,
        message: `Google says ${reason}`,
        errors: [{ reason }],
      },
    })

  it('about the grant is ConnectionRefused, in Google’s words', async () => {
    const api = makeFakeGmailApi({ now: NOW })
    const h = harness(api, forbidding(api, google('insufficientPermissions')))
    expect(failureOf(await h.run(null))).toMatchObject({
      _tag: 'ConnectionRefused',
      reason:
        'Google refused the Gmail connection (Google says insufficientPermissions): reconnect it',
    })
  })

  it('about a quota backs off', async () => {
    for (const reason of [
      'dailyLimitExceeded',
      'userRateLimitExceeded',
      'rateLimitExceeded',
    ]) {
      const api = makeFakeGmailApi({ now: NOW })
      const h = harness(api, forbidding(api, google(reason)))
      expect(failureOf(await h.run(null))).toMatchObject({
        _tag: 'JobRateLimited',
      })
    }
  })

  it('that cannot be read is retried, never a refusal', async () => {
    const api = makeFakeGmailApi({ now: NOW })
    const h = harness(api, forbidding(api, '<html>Forbidden</html>'))
    expect(failureOf(await h.run(null))).toMatchObject({ _tag: 'JobRetryable' })
  })
})

describe('a run that cannot file everything', () => {
  it('skips a message the host cannot file, says why, and goes on', async () => {
    const api = makeFakeGmailApi({ now: NOW })
    const log = LogTest()
    const filed: Array<string> = []
    const content = Layer.succeed(
      Content,
      Content.of({
        fileDocument: () => Effect.die('unused'),
        logInteraction: () => Effect.die('unused'),
        emitSignal: () => Effect.die('unused'),
        logMeeting: () => Effect.die('unused'),
        logEmail: (claim) =>
          claim.providerMessageId === 'm-gamma-intro'
            ? Effect.fail(new JobRetryable({ reason: 'the parser threw' }))
            : Effect.sync(() => {
                filed.push(claim.providerMessageId)
                return {
                  outcome: 'created' as const,
                  interactionId: claim.providerMessageId,
                }
              }),
      }),
    )
    const exit = await Effect.runPromiseExit(
      plugin.jobs
        .sync({ cursor: null, connectedAt: CONNECTED })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              HttpFetchTest(api.fetch).layer,
              SecretsTest({ accessToken: api.accessToken }).layer,
              content,
              log.layer,
            ),
          ),
        ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(filed).toEqual(AFTER_CONNECT.filter((id) => id !== 'm-gamma-intro'))
    expect(log.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          fields: { id: 'm-gamma-intro', reason: 'the parser threw' },
        }),
      ]),
    )
  })

  it('keeps the history it reached when a later batch fails', async () => {
    const api = makeFakeGmailApi({ now: NOW, seed: [] })
    const cursor = await harness(api).ok(null)
    const ids = Array.from(
      { length: 60 },
      (_, i) => `m-${String(i).padStart(2, '0')}`,
    )
    ids.forEach((id, i) => api.deliver(later(id, NOW + i * 1_000)))
    let batches = 0
    const failing: FetchLike = (url, init) =>
      url.includes('/batch/') && ++batches === 2
        ? Promise.resolve(new Response('busy', { status: 503 }))
        : api.fetch(url, init)
    const cut = harness(api, failing)
    const reached = await cut.ok(cursor)
    expect(cut.ids()).toEqual(ids.slice(0, 50))
    expect(Number(reached)).toBeLessThan(api.historyId())
    const rest = harness(api)
    expect(await rest.ok(reached)).toBe(String(api.historyId()))
    expect(rest.ids()).toEqual(ids.slice(50))
  })
})
