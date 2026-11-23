import { describe, expect, it, vi } from 'vitest'
import {
  NO_CHOICES,
  blankDraft,
  choicesOf,
  emailRecordAction,
  messageCount,
  openBlankCount,
  reviewCopies,
  sendLabel,
  withChoices,
  withTemplate,
} from './compose'

/**
 * A new email's seams: the blank draft with a record's To, a template
 * applied over it keeping the recipients, and Cmd-K's `Email <name>`; and
 * Review's: the copies it shows, the primary's count wording, the blank
 * gate, and the fills kept on the To chips.
 */

const DEV = { email: 'dev@flent.example', entityId: 'p-dev', name: 'Dev Shah' }

describe('a new email', () => {
  it('starts blank under its id, to the record’s prefill', () => {
    expect(blankDraft('d1', [DEV])).toEqual({
      id: 'd1',
      mode: 'new',
      inReplyToId: null,
      to: [DEV],
      cc: [],
      bcc: [],
      subject: '',
      bodyMd: '',
      attachments: [],
    })
    expect(blankDraft('d2').to).toEqual([])
  })

  it('takes a template’s subject, body and files, and keeps its recipients', () => {
    const file = {
      documentId: 'f1',
      name: 'deck.pdf',
      mime: 'application/pdf',
      sizeBytes: 10,
    }
    const applied = withTemplate(
      { ...blankDraft('d1', [DEV]), subject: 'Old', bodyMd: 'Old body' },
      { subject: 'Diligence next steps', bodyMd: 'Hi —', attachments: [file] },
    )
    expect(applied).toMatchObject({
      id: 'd1',
      to: [DEV],
      subject: 'Diligence next steps',
      bodyMd: 'Hi —',
      attachments: [file],
    })
  })

  it('offers Email <name> in Cmd-K, running the record’s composer', () => {
    const open = vi.fn()
    const action = emailRecordAction('Priya Raman', open)
    expect(action.label).toBe('Email Priya Raman')
    if (!('run' in action)) throw new Error('no run')
    action.run()
    expect(open).toHaveBeenCalledOnce()
  })
})

describe('Review', () => {
  const PRIYA = { email: 'priya@fund.example', name: 'Priya Raman' }
  const OPS = { email: 'ops@northgate.example' }
  const KAVYA = { email: 'kavya@fund.example', name: 'Kavya Iyer' }
  const rows = [
    { email: DEV.email, blanks: [] },
    { email: PRIYA.email, blanks: [] },
    { email: OPS.email, blanks: ['name.first'] },
    { email: KAVYA.email, blanks: ['name.first'] },
  ]

  it('counts what goes: Send for one message, Send 3 emails for three', () => {
    expect(sendLabel(messageCount(0))).toBe('Send')
    expect(sendLabel(messageCount(1))).toBe('Send')
    expect(sendLabel(messageCount(3))).toBe('Send 3 emails')
    expect(sendLabel(2)).toBe('Send 2 emails')
  })

  it('makes a copy per To recipient with variables, and none without', () => {
    const to = [DEV, PRIYA, { email: 'OPS@northgate.example' }]
    expect(reviewCopies(rows, to, true).map((r) => r.email)).toEqual([
      DEV.email,
      PRIYA.email,
      OPS.email,
    ])
    expect(reviewCopies(rows, to, false)).toEqual([])
  })

  it('holds Send while a copy has an open blank; a Bcc’s blank never does', () => {
    const copies = reviewCopies(rows, [DEV, PRIYA, OPS], true)
    expect(openBlankCount(copies, NO_CHOICES)).toBe(1)
    expect(
      openBlankCount(copies, {
        fills: { [OPS.email]: { 'name.first': '  ' } },
        accepted: [],
      }),
    ).toBe(1)
    expect(
      openBlankCount(copies, {
        fills: { [OPS.email]: { 'name.first': 'Ops' } },
        accepted: [],
      }),
    ).toBe(0)
    expect(openBlankCount(copies, { fills: {}, accepted: [OPS.email] })).toBe(0)
  })

  it('keeps a fill and a left blank on the To chip, and reads them back', () => {
    const to = withChoices([DEV, OPS], {
      fills: { [OPS.email]: { 'name.first': 'Ops', 'company.name': '' } },
      accepted: [DEV.email],
    })
    expect(to).toEqual([
      { ...DEV, blank: true },
      { ...OPS, fills: { 'name.first': 'Ops' } },
    ])
    expect(choicesOf(to)).toEqual({
      fills: { [OPS.email]: { 'name.first': 'Ops' } },
      accepted: [DEV.email],
    })
    // Cleared, the chips are bare again.
    expect(withChoices(to, NO_CHOICES)).toEqual([DEV, OPS])
  })
})
