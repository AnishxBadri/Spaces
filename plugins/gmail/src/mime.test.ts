import { readSentMessage } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import { buildMime, formatMailbox, markdownToHtml, uploadBody } from './mime.ts'
import type { OutgoingMessage } from './mime.ts'

/**
 * The message Send writes, read back by the fake's own MIME reader: the
 * headers a reply threads by, the alternative body, each file once, and
 * every byte surviving the base64 round trip.
 */

const message = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  messageId: 'spaces-d1-all@fund.example',
  date: new Date('2026-10-20T09:00:00.000Z'),
  from: { email: 'anish@fund.example', name: 'Anish' },
  to: [{ email: 'dana@flent.example', name: 'Dana Moreau' }],
  cc: [{ email: 'kiran@flent.example' }],
  bcc: [{ email: 'priya@fund.example', name: 'Priya Nair' }],
  subject: 'Flent — next steps',
  bodyMd: 'Hi Dana,\n\nThe **term sheet** is attached.\n\n> Earlier note',
  inReplyTo: null,
  references: [],
  attachments: [],
  ...over,
})

const text = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes ?? new Uint8Array())

describe('buildMime', () => {
  it('writes the headers, Bcc included, and no threading on a new email', () => {
    const { headers } = readSentMessage(buildMime(message()))
    expect(headers['message-id']).toBe('<spaces-d1-all@fund.example>')
    expect(headers.from).toBe('"Anish" <anish@fund.example>')
    expect(headers.to).toBe('"Dana Moreau" <dana@flent.example>')
    expect(headers.cc).toBe('kiran@flent.example')
    expect(headers.bcc).toBe('"Priya Nair" <priya@fund.example>')
    expect(headers.subject).toBe('Flent — next steps')
    expect(headers.date).toBe('Tue, 20 Oct 2026 09:00:00 GMT')
    expect(headers['in-reply-to']).toBeUndefined()
    expect(headers.references).toBeUndefined()
  })

  it('threads a reply by In-Reply-To and References', () => {
    const { headers } = readSentMessage(
      buildMime(
        message({
          inReplyTo: 'q3@flent.example',
          references: ['root@flent.example', 'q3@flent.example'],
        }),
      ),
    )
    expect(headers['in-reply-to']).toBe('<q3@flent.example>')
    expect(headers.references).toBe('<root@flent.example> <q3@flent.example>')
  })

  it('is the text as written and its markdown as HTML, as alternatives', () => {
    const raw = buildMime(message())
    expect(raw).toMatch(/Content-Type: multipart\/alternative/)
    const { parts } = readSentMessage(raw)
    expect(parts.map((p) => p.contentType)).toEqual(['text/plain', 'text/html'])
    expect(text(parts.at(0)?.bytes)).toBe(message().bodyMd)
    expect(text(parts.at(1)?.bytes)).toContain('<strong>term sheet</strong>')
    expect(text(parts.at(1)?.bytes)).toContain(
      '<blockquote><p>Earlier note</p></blockquote>',
    )
  })

  it('attaches each file once, and its bytes come back whole', () => {
    const deck = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256)
    const raw = buildMime(
      message({
        attachments: [
          { filename: 'deck.pdf', mime: 'application/pdf', bytes: deck },
          {
            filename: 'Modèle financier.xlsx',
            mime: 'application/vnd.ms-excel',
            bytes: new TextEncoder().encode('a,b\n1,2\n'),
          },
        ],
      }),
    )
    expect(raw).toMatch(/Content-Type: multipart\/mixed/)
    // ASCII throughout: it goes over the wire as text.
    const ascii = (c: string) => {
      const n = c.charCodeAt(0)
      return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 126)
    }
    expect([...raw].every(ascii)).toBe(true)
    const files = readSentMessage(raw).parts.filter((p) => p.filename !== null)
    expect(files.map((f) => f.filename)).toEqual([
      'deck.pdf',
      'Modèle financier.xlsx',
    ])
    expect(files.at(0)?.bytes).toEqual(deck)
    expect(text(files.at(1)?.bytes)).toBe('a,b\n1,2\n')
  })

  it('encodes a subject and a name that are not ASCII', () => {
    const raw = buildMime(
      message({
        subject: 'Rendez-vous à Paris',
        to: [{ email: 'zoe@flent.example', name: 'Zoé' }],
      }),
    )
    expect(raw).toContain('Subject: =?UTF-8?B?')
    const { headers } = readSentMessage(raw)
    expect(headers.subject).toBe('Rendez-vous à Paris')
    expect(headers.to).toBe('Zoé <zoe@flent.example>')
  })
})

describe('the pieces', () => {
  it('quotes a display name and leaves a bare address bare', () => {
    expect(formatMailbox({ email: 'a@b.example' })).toBe('a@b.example')
    expect(formatMailbox({ email: 'a@b.example', name: 'Doe, "J"' })).toBe(
      '"Doe, \\"J\\"" <a@b.example>',
    )
  })

  it('escapes HTML and links only http(s)', () => {
    const html = markdownToHtml(
      '<script>x</script> [deck](https://flent.example/d) [no](javascript:alert(1))',
    )
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<a href="https://flent.example/d">deck</a>')
    expect(html).not.toContain('href="javascript')
  })

  it('wraps the message in the upload body with the thread to join', () => {
    const body = uploadBody('Subject: x\r\n\r\nhi', 'thread-9')
    expect(body).toContain('{"threadId":"thread-9"}')
    expect(body).toContain('Content-Type: message/rfc822')
    expect(uploadBody('x', null)).toContain('{}')
  })
})
