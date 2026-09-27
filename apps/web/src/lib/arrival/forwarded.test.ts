import { describe, expect, it } from 'vitest'
import {
  APPLE_FORWARD,
  MAILBOX,
  OUTLOOK_FORWARD,
  bcc,
  gmailForward,
} from './fixtures'
import { parseAddresses, parseForwarded, parseLooseDate } from './forwarded'
import { arrivalFromSource } from './message'
import type { Arrival, ArrivalMessage } from './message'

/**
 * SPA-56 / D49: a true forward is matched on the original. Every fixture here
 * is a whole RFC 822 message run through mailparser and `toArrival` — no
 * database — and the assertion is the interaction the poll would write: the
 * original's sender and participants, dated from the block's date line, and
 * threaded on the block's own headers when it carries them.
 */

const opts = {
  mailboxAddress: MAILBOX,
  receivedAt: new Date('2026-09-27T00:00:00Z'),
}

function message(a: Arrival): ArrivalMessage {
  if (a.kind !== 'message') throw new Error(`refused: ${a.refusal.detail}`)
  return a.message
}

const emails = (m: ArrivalMessage) => m.participants.map((p) => p.email)

const TABLE: ReadonlyArray<{
  client: string
  raw: string
  from: string
  forwarder: string
  participants: Array<string>
  occurredAt: string
  subject: string
  thread: string | RegExp
  messageId: string | RegExp
}> = [
  {
    client: 'Gmail',
    raw: gmailForward(),
    from: 'jane@acme.io',
    forwarder: 'anish@fund.example',
    participants: ['jane@acme.io', 'anish@fund.example', 'raj@acme.io'],
    // Gmail prints the forwarder's local time with no zone; read as UTC.
    occurredAt: '2026-09-21T10:04:00.000Z',
    subject: 'Seed round',
    // No headers in the block: the thread is the derived id.
    thread: /^fwd-[0-9a-f]{40}@forwarded\.invalid$/,
    messageId: /^fwd-[0-9a-f]{40}@forwarded\.invalid$/,
  },
  {
    client: 'Outlook',
    raw: OUTLOOK_FORWARD,
    from: 'priya@beta.dev',
    forwarder: 'anish@fund.example',
    participants: [
      'priya@beta.dev',
      'anish@fund.example',
      'sam@beta.dev',
      'lee@gamma.vc',
    ],
    occurredAt: '2026-09-21T15:15:00.000Z',
    subject: 'Series A update',
    thread: /^fwd-[0-9a-f]{40}@forwarded\.invalid$/,
    messageId: /^fwd-[0-9a-f]{40}@forwarded\.invalid$/,
  },
  {
    client: 'Apple Mail',
    raw: APPLE_FORWARD,
    from: 'omar@delta.ai',
    forwarder: 'anish@fund.example',
    participants: ['omar@delta.ai', 'anish@fund.example'],
    // 18:30 BST is 17:30 UTC.
    occurredAt: '2026-09-21T17:30:00.000Z',
    subject: 'Re: Intro',
    // The block carries References: the thread is its root.
    thread: 'root-777@delta.ai',
    messageId: 'CAB123@delta.ai',
  },
]

describe('a true forward is matched on the original', () => {
  it.each(TABLE)('$client', async (row) => {
    const m = message(await arrivalFromSource(row.raw, opts))
    expect(m.forwarded).toBe(true)
    expect(m.from?.email).toBe(row.from)
    expect(m.forwarder?.email).toBe(row.forwarder)
    expect(emails(m)).toEqual(row.participants)
    expect(m.occurredAt.toISOString()).toBe(row.occurredAt)
    expect(m.subject).toBe(row.subject)
    if (typeof row.thread === 'string') expect(m.threadId).toBe(row.thread)
    else expect(m.threadId).toMatch(row.thread)
    if (typeof row.messageId === 'string')
      expect(m.messageId).toBe(row.messageId)
    else expect(m.messageId).toMatch(row.messageId)
    // The body is the whole wrapper, forwarder's note and all.
    expect(m.body.length).toBeGreaterThan(0)
  })

  it('keys two forwards of one original alike, whatever the wrapper', async () => {
    const a = message(await arrivalFromSource(gmailForward('one@x'), opts))
    const b = message(await arrivalFromSource(gmailForward('two@x'), opts))
    expect(a.messageId).toBe(b.messageId)
  })

  it('reads a BCC on its own headers, threaded on its References root', async () => {
    const m = message(
      await arrivalFromSource(
        bcc({
          messageId: 'reply-2@acme.io',
          from: 'Jane Founder <jane@acme.io>',
          to: `Anish <anish@fund.example>, ${MAILBOX}`,
          subject: 'Re: Seed round',
          inReplyTo: 'reply-1@fund.example',
          references: '<root-1@acme.io> <reply-1@fund.example>',
        }),
        opts,
      ),
    )
    expect(m.forwarded).toBe(false)
    expect(m.messageId).toBe('reply-2@acme.io')
    expect(m.threadId).toBe('root-1@acme.io')
    // The mailbox itself is never a participant.
    expect(emails(m)).toEqual(['jane@acme.io', 'anish@fund.example'])
    expect(m.occurredAt.toISOString()).toBe('2026-09-21T10:04:00.000Z')
  })

  it('refuses a forward of a noreply notification on the original sender', async () => {
    const raw = gmailForward().replace(
      'From: Jane Founder <jane@acme.io>',
      'From: DocSend <no-reply@docsend.com>',
    )
    const a = await arrivalFromSource(raw, opts)
    expect(a.kind).toBe('refused')
    if (a.kind === 'refused') expect(a.refusal.reason).toBe('role-sender')
  })

  it('refuses a message with no Message-ID', async () => {
    const a = await arrivalFromSource(
      bcc({ messageId: '', from: 'jane@acme.io', to: MAILBOX, subject: 'x' }),
      opts,
    )
    expect(a.kind === 'refused' && a.refusal.reason).toBe('no-message-id')
  })
})

describe('the block parser', () => {
  it('reads quoted and starred header lines', () => {
    const block = parseForwarded(
      [
        '> -----Original Message-----',
        '> *From:* Jane Founder [mailto:jane@acme.io]',
        '> *Sent:* 21/09/2026 10:04',
        '> *To:* anish@fund.example',
        '> *Subject:* Hello',
        '>',
        '> body',
      ].join('\n'),
    )
    expect(block?.from).toEqual({ email: 'jane@acme.io', name: 'Jane Founder' })
    expect(block?.date?.toISOString()).toBe('2026-09-21T10:04:00.000Z')
    expect(block?.subject).toBe('Hello')
  })

  it('returns null for a body with no block', () => {
    expect(parseForwarded('Just a note.\n\nThanks')).toBeNull()
  })

  it('splits names from addresses, quotes and all', () => {
    expect(
      parseAddresses('"Doe, John" <john@x.io>; bob@y.io, Jane <JANE@Z.IO>'),
    ).toEqual([
      { email: 'john@x.io', name: 'Doe, John' },
      { email: 'bob@y.io', name: null },
      { email: 'jane@z.io', name: 'Jane' },
    ])
  })

  it.each([
    ['Mon, Sep 21, 2026 at 10:04 AM', '2026-09-21T10:04:00.000Z'],
    ['Mon, Sep 21, 2026 at 12:30 PM', '2026-09-21T12:30:00.000Z'],
    ['Monday, September 21, 2026 3:15 PM', '2026-09-21T15:15:00.000Z'],
    ['21 September 2026 at 18:30:00 BST', '2026-09-21T17:30:00.000Z'],
    ['Mon, 21 Sep 2026 10:04:00 +0530', '2026-09-21T04:34:00.000Z'],
    ['2026-09-21 10:04', '2026-09-21T10:04:00.000Z'],
    ['September 21, 2026 at 9:00:00 AM PDT', '2026-09-21T16:00:00.000Z'],
  ])('reads %s', (line, iso) => {
    expect(parseLooseDate(line)?.toISOString()).toBe(iso)
  })

  it('answers null for a line with no date in it', () => {
    expect(parseLooseDate('sometime last week')).toBeNull()
  })
})
