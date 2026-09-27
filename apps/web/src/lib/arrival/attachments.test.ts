import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { minimalPdf } from '#/test/minimal-pdf'
import { SIGNATURE_IMAGE_FLOOR_BYTES, referencedCids } from './attachments'
import { chooseFilingCompany } from './file'
import {
  MAILBOX,
  bcc,
  bccHeaders,
  fillerBytes,
  gmailForward,
  withParts,
} from './fixtures'
import { arrivalFromSource } from './message'
import type { ArrivalMessage } from './message'

/**
 * SPA-115's pure half: which parts of a real MIME tree are documents. The
 * fixture is parsed by mailparser exactly as the poll parses a fetched
 * message, so the dispositions, the Content-IDs and the HTML are what a
 * client sends, not a hand-built stand-in for mailparser's output.
 */

async function parse(raw: string): Promise<ArrivalMessage> {
  const arrival = await arrivalFromSource(raw, {
    mailboxAddress: MAILBOX,
    receivedAt: new Date('2026-09-28T00:00:00Z'),
  })
  if (arrival.kind !== 'message') throw new Error('refused')
  return arrival.message
}

const headers = bccHeaders({
  messageId: 'deck-1@acme.io',
  from: 'Jane Founder <jane@acme.io>',
  to: 'Anish <anish@fund.example>',
  subject: 'Acme seed deck',
})

describe('sorting a message’s parts', () => {
  it('skips a cid-referenced inline image and a signature image, and files the rest — a small genuine attachment included', async () => {
    const message = await parse(
      withParts({
        headers,
        text: 'Deck attached.',
        html: '<p>Deck attached.</p><img src="cid:banner@acme.io"><p>Jane</p>',
        parts: [
          // Referenced by the HTML and inline: part of the body. Big enough
          // that the floor is not what skips it.
          {
            filename: 'banner.png',
            mime: 'image/png',
            content: fillerBytes(40_000),
            disposition: 'inline',
            cid: 'banner@acme.io',
          },
          // Outlook's signature logo: attachment disposition, tiny.
          {
            filename: 'image001.png',
            mime: 'image/png',
            content: fillerBytes(3_000, 1),
            disposition: 'attachment',
          },
          { filename: 'Acme seed.pdf', ...pdf('Acme seed deck') },
          // A genuine attachment far under the image floor: filed.
          {
            filename: 'cap-table.csv',
            mime: 'text/csv',
            content: Buffer.from('holder,shares\nJane,1000000\n'),
            disposition: 'attachment',
          },
          // Apple Mail sends a real attachment inline, with a Content-ID the
          // HTML never mentions: filed.
          {
            filename: 'Term sheet.pdf',
            ...pdf('Term sheet'),
            disposition: 'inline',
            cid: 'apple-4411@acme.io',
          },
          // An inline image nobody references, above the floor: a photo
          // sent as itself, filed.
          {
            filename: 'Team.jpg',
            mime: 'image/jpeg',
            content: fillerBytes(SIGNATURE_IMAGE_FLOOR_BYTES + 1, 2),
            disposition: 'inline',
            cid: 'team-photo@acme.io',
          },
        ],
      }),
    )

    expect(message.attachments.skipped).toEqual([
      { filename: 'banner.png', reason: 'inline-image' },
      { filename: 'image001.png', reason: 'signature-image' },
    ])
    expect(
      message.attachments.file.map((a) => [
        a.filename,
        a.mime,
        a.content.length,
      ]),
    ).toEqual([
      ['Term sheet.pdf', 'application/pdf', pdf('Term sheet').content.length],
      ['Team.jpg', 'image/jpeg', SIGNATURE_IMAGE_FLOOR_BYTES + 1],
      [
        'Acme seed.pdf',
        'application/pdf',
        pdf('Acme seed deck').content.length,
      ],
      ['cap-table.csv', 'text/csv', 27],
    ])
    // Decoded, byte for byte: what intake hashes is the file, not its base64.
    expect(
      message.attachments.file
        .find((a) => a.filename === 'Acme seed.pdf')
        ?.content.equals(pdf('Acme seed deck').content),
    ).toBe(true)
  })

  it('an inline image the message has no HTML to reference is a file', async () => {
    const message = await parse(
      withParts({
        headers,
        text: 'Screenshot of the dashboard.',
        parts: [
          {
            filename: 'dashboard.png',
            mime: 'image/png',
            content: fillerBytes(50_000),
            disposition: 'inline',
            cid: 'dash@acme.io',
          },
        ],
      }),
    )
    expect(message.attachments.file.map((a) => a.filename)).toEqual([
      'dashboard.png',
    ])
    expect(message.attachments.skipped).toEqual([])
  })

  it('a plain-text message has no parts, and a forward carries the wrapper’s', async () => {
    const plain = await parse(
      bcc({
        messageId: 'p-1@acme.io',
        from: 'jane@acme.io',
        to: 'anish@fund.example',
        subject: 'Hi',
      }),
    )
    expect(plain.attachments).toEqual({ file: [], skipped: [] })

    // Gmail's forward keeps the original's attachment on the wrapper.
    const [head, body] = splitHeaders(gmailForward())
    const forward = await parse(
      withParts({
        headers: head.filter((l) => !/^(MIME-Version|Content-Type):/i.test(l)),
        text: body,
        parts: [{ filename: 'Acme seed.pdf', ...pdf('Acme seed deck') }],
      }),
    )
    expect(forward.forwarded).toBe(true)
    expect(forward.subject).toBe('Seed round')
    expect(forward.attachments.file.map((a) => a.filename)).toEqual([
      'Acme seed.pdf',
    ])
  })

  it('reads the cid references a client writes', () => {
    expect(
      referencedCids(
        `<img src="cid:a@x"><img src='CID:B@X'><img src=cid:c%40x>` +
          `<div style="background:url(cid:d@x)">`,
      ),
    ).toEqual(new Set(['a@x', 'b@x', 'c@x', 'd@x']))
    expect(referencedCids(false)).toEqual(new Set())
  })
})

describe('the company a thread’s attachments file onto', () => {
  it('is the one company on the thread', () => {
    expect(chooseFilingCompany(['acme'], [])).toBe('acme')
    expect(chooseFilingCompany(['acme', 'acme'], ['jane'])).toBe('acme')
  })

  it('among several, is the sender’s — else none', () => {
    expect(chooseFilingCompany(['beta', 'gamma'], ['priya', 'beta'])).toBe(
      'beta',
    )
    expect(chooseFilingCompany(['beta', 'gamma'], ['anish'])).toBe(null)
    expect(chooseFilingCompany([], ['anish'])).toBe(null)
  })
})

describe('the lane files as other and classifies nothing', () => {
  it('passes kind other, and nothing under lib/arrival reaches the classify lane', () => {
    const dir = import.meta.dirname
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
    const filing = readFileSync(join(dir, 'attachment-filing.ts'), 'utf8')
    expect(filing).toMatch(/kind: 'other',/)
    // Imports and calls, not prose: the modules explain why they do not.
    for (const src of sources) {
      expect(src).not.toMatch(/from '[^']*(?:classify|on-extracted)[^']*'/)
      expect(src).not.toMatch(/(?:guessDocumentKind|onDocumentExtracted)\(/)
    }
  })
})

function pdf(phrase: string): {
  mime: string
  content: Buffer
  disposition: 'attachment'
} {
  return {
    mime: 'application/pdf',
    content: minimalPdf(phrase),
    disposition: 'attachment',
  }
}

function splitHeaders(raw: string): [Array<string>, string] {
  const at = raw.indexOf('\n\n')
  return [raw.slice(0, at).split('\n'), raw.slice(at + 2)]
}
