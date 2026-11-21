import { describe, expect, it } from 'vitest'
import type { EmailDetail, EmailThreadLine } from '#/lib/server-fns'
import { senderLine, threadCards } from './message-card'
import { splitQuotedText } from './quoted'

/**
 * A message card's header line, written one way everywhere (sender →
 * recipients, `you` first and absent when you were not on it, counted
 * past three), the thread's card order, and quoted history split off a
 * plain-text body.
 */

const person = (name: string | null, you = false) => ({
  email: `${(name ?? 'legal').toLowerCase().replace(' ', '.')}@x.example`,
  name,
  you,
})
const YOU = person('Anish Badri', true)
const DEV = person('Dev Shah')
const PRIYA = person('Priya Raman')
const ROHAN = person('Rohan Gupta')
const MEERA = person('Meera Nair')
const ARJUN = person('Arjun Mehta')

/** A window's message with nothing in it, for the card order. */
const WINDOW: EmailDetail = {
  id: 'w',
  subject: null,
  occurredAt: '2026-10-14T09:00:00.000Z',
  from: null,
  to: [],
  cc: [],
  bcc: [],
  via: null,
  preview: null,
  body: { kind: 'none' },
  attachments: [],
  privacy: null,
  categories: [],
  thread: { messages: 3, earlier: [] },
  record: null,
  gmailUrl: null,
}

describe('the sender line', () => {
  it('reads someone else’s message to you', () => {
    expect(senderLine({ from: DEV, to: [YOU], cc: [] })).toBe('Dev Shah → you')
  })

  it('reads your own message as You', () => {
    expect(senderLine({ from: YOU, to: [PRIYA], cc: [] })).toBe(
      'You → Priya Raman',
    )
  })

  it('names the cc after the To', () => {
    expect(senderLine({ from: DEV, to: [YOU], cc: [PRIYA] })).toBe(
      'Dev Shah → you, cc Priya Raman',
    )
  })

  it('puts you first among the recipients', () => {
    expect(senderLine({ from: DEV, to: [PRIYA, YOU], cc: [] })).toBe(
      'Dev Shah → you, Priya Raman',
    )
  })

  it('leaves you out of mail you were not on', () => {
    expect(senderLine({ from: DEV, to: [PRIYA], cc: [ROHAN] })).toBe(
      'Dev Shah → Priya Raman, cc Rohan Gupta',
    )
  })

  it('prints an address with no name as the address', () => {
    expect(senderLine({ from: person(null), to: [YOU], cc: [] })).toBe(
      'legal@x.example → you',
    )
  })

  it('counts past three names, and a folded card past its first', () => {
    const many = {
      from: PRIYA,
      to: [DEV, ROHAN, YOU, MEERA, ARJUN],
      cc: [person('Kavya Iyer'), person('Sana Ali'), person(null)],
    }
    expect(senderLine(many)).toBe(
      'Priya Raman → you, Dev Shah, Rohan Gupta +2 · cc 3',
    )
    expect(senderLine(many, true)).toBe('Priya Raman → you +7')
  })

  it('reads a message with no recipients as its sender alone', () => {
    expect(senderLine({ from: DEV, to: [], cc: [] })).toBe('Dev Shah')
    expect(senderLine({ from: null, to: [YOU], cc: [] })).toBe(
      'Unknown sender → you',
    )
  })
})

describe('the thread’s cards', () => {
  const line = (id: string, occurredAt: string): EmailThreadLine => ({
    id,
    from: DEV,
    to: [YOU],
    cc: [],
    preview: null,
    attachments: 0,
    occurredAt,
  })

  it('runs oldest first and ends on the newest', () => {
    const newest = {
      id: 'c',
      from: DEV,
      to: [YOU],
      cc: [],
      preview: 'Latest',
      attachments: [],
      occurredAt: '2026-10-14T09:00:00.000Z',
    } satisfies Partial<EmailDetail>
    const cards = threadCards(
      [
        line('a', '2026-10-12T09:00:00.000Z'),
        line('b', '2026-10-13T09:00:00.000Z'),
      ],
      // Only the fields a card reads; the rest is the window's.
      { ...WINDOW, ...newest },
    )
    expect(cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(cards.at(-1)).toMatchObject({ preview: 'Latest', attachments: 0 })
  })
})

describe('quoted history', () => {
  it('folds from the reply header through the end', () => {
    expect(
      splitQuotedText('Thanks.\n\nOn Tue, 14 Oct, Dev wrote:\n> the file'),
    ).toEqual({
      main: 'Thanks.',
      quoted: 'On Tue, 14 Oct, Dev wrote:\n> the file',
    })
  })

  it('folds an Outlook original and a calendar footer', () => {
    expect(
      splitQuotedText('See you.\n-----Original Message-----\nFrom: Dev').quoted,
    ).toBe('-----Original Message-----\nFrom: Dev')
    expect(
      splitQuotedText('Agenda below.\nInvitation from Google Calendar: x').main,
    ).toBe('Agenda below.')
  })

  it('keeps a body that is nothing but history, and one with none', () => {
    expect(splitQuotedText('> only quoted').quoted).toBeNull()
    expect(splitQuotedText('Plain note.').quoted).toBeNull()
  })
})
