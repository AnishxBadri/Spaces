import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import { minimalPdf } from '#/test/minimal-pdf'
import { MAILBOX, bccHeaders, fillerBytes, withParts } from './fixtures'
import { arrivalFromSource } from './message'
import { stripAttachmentBodies } from './strip-mime'

/**
 * The stored MIME: headers, the text and HTML parts and the inline
 * `cid:` images stay; every attachment part keeps its headers and loses its
 * body. Read back through mailparser, as `renderMime` reads it.
 */

const deck = minimalPdf('Acme seed deck')
const banner = fillerBytes(60_000)

const raw = withParts({
  headers: bccHeaders({
    messageId: 'strip-1@acme.io',
    from: 'Jane Founder <jane@acme.io>',
    to: 'Anish <anish@fund.example>',
    subject: 'Acme seed deck',
  }),
  text: 'Deck attached.',
  html: '<p>Deck attached.</p><img src="cid:banner@acme.io">',
  parts: [
    {
      filename: 'banner.png',
      mime: 'image/png',
      content: banner,
      disposition: 'inline',
      cid: 'banner@acme.io',
    },
    {
      filename: 'logo.png',
      mime: 'image/png',
      content: fillerBytes(4_000, 1),
      disposition: 'attachment',
    },
    {
      filename: 'Acme seed.pdf',
      mime: 'application/pdf',
      content: deck,
      disposition: 'attachment',
    },
    {
      filename: 'invite.ics',
      mime: 'text/calendar',
      content: Buffer.from('BEGIN:VCALENDAR\nEND:VCALENDAR\n'),
      disposition: 'attachment',
    },
  ],
})

describe('the stored MIME', () => {
  it('keeps the headers, the text, the HTML and the inline image; drops every attachment body', async () => {
    const stored = stripAttachmentBodies(
      Buffer.from(raw),
      new Set(['banner@acme.io']),
    )
    expect(stored.length).toBeLessThan(Buffer.byteLength(raw))

    const parsed = await simpleParser(stored)
    expect(parsed.subject).toBe('Acme seed deck')
    expect(parsed.messageId).toBe('<strip-1@acme.io>')
    expect(parsed.text?.trim()).toBe('Deck attached.')
    // mailparser inlines a `cid:` image it holds as a `data:` URI, as
    // `renderMime` shows it.
    expect(parsed.html).toContain('src="data:image/png;base64,')
    const sizes = Object.fromEntries(
      parsed.attachments.map((a) => [a.filename, a.content.length]),
    )
    expect(sizes).toEqual({
      'banner.png': banner.length,
      'logo.png': 0,
      'Acme seed.pdf': 0,
      'invite.ics': 0,
    })
  })

  it('is what an arrival carries, so the lane stores nothing twice', async () => {
    const arrival = await arrivalFromSource(raw, {
      mailboxAddress: MAILBOX,
      receivedAt: new Date('2026-09-28T00:00:00Z'),
    })
    if (arrival.kind !== 'message') throw new Error('refused')
    const parsed = await simpleParser(arrival.message.mime)
    expect(
      parsed.attachments.find((a) => a.filename === 'Acme seed.pdf')?.content
        .length,
    ).toBe(0)
    // The files themselves still reach the lane, decoded.
    expect(arrival.message.attachments.file.map((a) => a.filename)).toEqual([
      'Acme seed.pdf',
    ])
    expect(arrival.message.attachments.skipped).toEqual([
      { filename: 'banner.png', reason: 'inline-image' },
      { filename: 'logo.png', reason: 'signature-image' },
      { filename: 'invite.ics', reason: 'calendar-invite' },
    ])
  })

  it('leaves a single-part message and a malformed multipart as they came', () => {
    const plain = 'Subject: hi\nContent-Type: text/plain\n\nhello\n'
    expect(
      stripAttachmentBodies(Buffer.from(plain), new Set()).toString(),
    ).toBe(plain)
    const broken =
      'Subject: hi\nContent-Type: multipart/mixed\n\nno boundary here\n'
    expect(
      stripAttachmentBodies(Buffer.from(broken), new Set()).toString(),
    ).toBe(broken)
  })
})
