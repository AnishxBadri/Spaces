import { Cause, Effect, Exit, Layer } from 'effect'
import type { EmailClaim, OutgoingEmail } from '@spaces/sdk'
import {
  ContentTest,
  FAKE_GMAIL_OWNER,
  HttpFetchTest,
  LogTest,
  SecretsTest,
  fromBase64Url,
  makeFakeGmailApi,
} from '@spaces/sdk/testing'
import type { FakeGmailApi, FetchLike } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.ts'
import { send } from './send.ts'

/**
 * Send against the in-repo fake of Gmail: the message built, sent through
 * the upload endpoint into the right thread, its sent copy handed to
 * `Content.logEmail`, and Gmail's own words kept when it refuses.
 */

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const BLOB = 'http://localhost:3000/api/blob/'

const files: { readonly [url: string]: Uint8Array<ArrayBuffer> } = {
  [`${BLOB}deck`]: new TextEncoder().encode('%PDF-1.4 deck %%EOF'),
  [`${BLOB}model`]: new TextEncoder().encode('a,b\n1,2\n'),
}

const blobs: FetchLike = (target) => {
  const bytes = Object.hasOwn(files, target) ? files[target] : undefined
  return Promise.resolve(
    bytes === undefined
      ? new Response('gone', { status: 404 })
      : new Response(bytes, { status: 200 }),
  )
}

const outgoing = (over: Partial<OutgoingEmail> = {}): OutgoingEmail => ({
  messageId: 'spaces-d1-all@fund.example',
  from: { email: FAKE_GMAIL_OWNER, name: 'Anish' },
  to: [{ email: 'jane@acme-robotics.example', name: 'Jane Founder' }],
  cc: [],
  bcc: [{ email: 'priya@fund.example' }],
  subject: 'Re: Acme Robotics — Q3 update',
  bodyMd: 'Thanks Jane — the board pack is great.',
  inReplyTo: null,
  references: [],
  attachments: [],
  ...over,
})

const harness = (
  api: FakeGmailApi = makeFakeGmailApi({ now: NOW, others: blobs }),
) => {
  const content = ContentTest()
  const log = LogTest()
  const layer = Layer.mergeAll(
    HttpFetchTest(api.fetch).layer,
    SecretsTest({ accessToken: api.accessToken }).layer,
    content.layer,
    log.layer,
  )
  const run = (payload: OutgoingEmail) =>
    Effect.runPromiseExit(send({ payload }).pipe(Effect.provide(layer)))
  const claims = () =>
    content.calls
      .map((c) => c.input)
      .filter(
        (x): x is EmailClaim =>
          typeof x === 'object' &&
          x !== null &&
          '_tag' in x &&
          x._tag === 'email',
      )
  return { api, run, claims, log }
}

const sends = (api: FakeGmailApi) =>
  api.requests.filter((r) => r.path === '/users/me/messages/send')

describe('send', () => {
  it('is a payload action, interactive and never retried', () => {
    expect(plugin.jobs.send).toBe(send)
    expect(plugin.manifest.jobs.send).toMatchObject({
      trigger: 'action',
      input: 'payload',
      interactive: true,
      retry: 0,
    })
  })

  it('sends once with the host’s Message-ID and Bcc, and files the mailbox’s copy', async () => {
    const h = harness()
    const exit = await h.run(outgoing())
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(sends(h.api)).toHaveLength(1)
    const sent = h.api.sent().at(0)
    expect(sent?.headers['message-id']).toBe('<spaces-d1-all@fund.example>')
    expect(sent?.headers.bcc).toBe('priya@fund.example')
    expect(sent?.threadId).toBeNull()
    // The copy Gmail holds is what the lane files: one claim, labelled Sent.
    const claim = h.claims().at(0)
    expect(h.claims()).toHaveLength(1)
    expect(claim?.labels).toEqual(['Sent'])
    expect(fromBase64Url(claim?.raw ?? '')).toContain(
      'Message-ID: <spaces-d1-all@fund.example>',
    )
  })

  it('replies into the parent’s thread with In-Reply-To and References', async () => {
    const h = harness()
    const exit = await h.run(
      outgoing({
        inReplyTo: 'acme-q3@acme-robotics.example',
        references: ['acme-q3@acme-robotics.example'],
      }),
    )
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    const sent = h.api.sent().at(0)
    expect(sent?.headers['in-reply-to']).toBe('<acme-q3@acme-robotics.example>')
    expect(sent?.headers.references).toBe('<acme-q3@acme-robotics.example>')
    // The parent was found by its Message-ID and its Gmail thread joined.
    expect(sent?.threadId).toBe('m-acme-update')
  })

  it('reads each file from the host’s URL and attaches it once', async () => {
    const h = harness()
    const exit = await h.run(
      outgoing({
        attachments: [
          {
            filename: 'deck.pdf',
            mime: 'application/pdf',
            url: `${BLOB}deck`,
            sizeBytes: 19,
          },
          {
            filename: 'model.csv',
            mime: 'text/csv',
            url: `${BLOB}model`,
            sizeBytes: 8,
          },
        ],
      }),
    )
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    const attached = (h.api.sent().at(0)?.parts ?? []).filter(
      (p) => p.filename !== null,
    )
    expect(attached.map((p) => [p.filename, p.contentType])).toEqual([
      ['deck.pdf', 'application/pdf'],
      ['model.csv', 'text/csv'],
    ])
    expect(attached.at(0)?.bytes).toEqual(files[`${BLOB}deck`])
  })

  it('refuses files over 25 MB before any request', async () => {
    const h = harness()
    const exit = await h.run(
      outgoing({
        attachments: [
          {
            filename: 'big.zip',
            mime: 'application/zip',
            url: `${BLOB}deck`,
            sizeBytes: 26 * 1024 * 1024,
          },
        ],
      }),
    )
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : null,
    ).toMatchObject({
      _tag: 'JobPermanent',
      reason: 'The files come to 26.0 MB; Gmail sends 25 MB at most',
    })
    expect(h.api.requests).toHaveLength(0)
  })

  it('does not send again a message the mailbox already holds', async () => {
    const h = harness()
    await h.run(outgoing())
    const second = await h.run(outgoing())
    expect(Exit.isSuccess(second)).toBe(true)
    expect(sends(h.api)).toHaveLength(1)
    expect(h.claims()).toHaveLength(2)
  })

  it('fails retryable with Gmail’s words on a 5xx, and sends nothing', async () => {
    const h = harness()
    h.api.failNext(
      503,
      'The service is currently unavailable.',
      '/users/me/messages/send',
    )
    const failed = await h.run(outgoing())
    expect(
      Exit.isFailure(failed) ? Cause.squash(failed.cause) : null,
    ).toMatchObject({
      _tag: 'JobRetryable',
      reason: 'Gmail answered 503: The service is currently unavailable.',
    })
    expect(h.api.sent()).toHaveLength(0)
    expect(h.claims()).toHaveLength(0)
  })
})
