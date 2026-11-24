import { describe, expect, it, vi } from 'vitest'
import {
  NO_CHOICES,
  blankDraft,
  choicesOf,
  draftStateOf,
  emailRecordAction,
  messageCount,
  openBlankCount,
  reconnectHref,
  reconnectReturn,
  replyDraft,
  reviewCopies,
  sendLabel,
  switchMode,
  withChoices,
  withTemplate,
} from './compose'
import { bodyWritten } from './signature'

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

describe('the signature', () => {
  const SIG = 'Anish Badri\nPartner, Fund'
  const QUOTE = [
    '---------- Forwarded message ----------',
    'From: dev@flent.example',
    '',
    'The deck.',
  ].join('\n')
  const start = (mode: 'reply' | 'reply_all' | 'forward') => ({
    mode,
    inReplyToId: 'e1',
    to: mode === 'forward' ? [] : [DEV],
    cc: [],
    bcc: [],
    subject: mode === 'forward' ? 'Fwd: Deck' : 'Re: Deck',
    bodyMd: mode === 'forward' ? QUOTE : '',
    attachments: [],
  })
  const modes = {
    reply: start('reply'),
    reply_all: start('reply_all'),
    forward: start('forward'),
  }

  it('sits at the foot of a new email after a blank line, its blank edges trimmed', () => {
    expect(blankDraft('d1', [DEV], `\n${SIG}  \n\n`).bodyMd).toBe(`\n\n${SIG}`)
  })

  it('sits at the foot of a reply after a blank line', () => {
    const reply = replyDraft('d1', modes.reply, SIG)
    expect(reply).toMatchObject({ id: 'd1', mode: 'reply', to: [DEV] })
    expect(reply.bodyMd).toBe(`\n\n${SIG}`)
  })

  it('goes before a forward’s quoted message, once', () => {
    const forward = replyDraft('d1', modes.forward, SIG)
    expect(forward.bodyMd).toBe(`\n\n${SIG}\n\n${QUOTE}`)
    expect(forward.bodyMd.split(SIG)).toHaveLength(2)
  })

  it('stays as written text when the mode switches, and stays gone once deleted', () => {
    const reply = {
      ...replyDraft('d1', modes.reply, SIG),
      bodyMd: `Thanks Dev.\n\n${SIG}`,
    }
    const forward = switchMode(reply, modes.reply, modes.forward)
    expect(forward.bodyMd).toBe(`Thanks Dev.\n\n${SIG}\n\n${QUOTE}`)
    expect(switchMode(forward, modes.forward, modes.reply).bodyMd).toBe(
      `Thanks Dev.\n\n${SIG}`,
    )
    const unsigned = { ...reply, bodyMd: 'Thanks Dev.' }
    expect(switchMode(unsigned, modes.reply, modes.forward).bodyMd).toBe(
      `Thanks Dev.\n\n${QUOTE}`,
    )
  })

  it('keeps its place under a template applied later, once however often one is applied', () => {
    const fill = { subject: 'Next steps', bodyMd: 'Hi —\n\n', attachments: [] }
    const once = withTemplate(blankDraft('d1', [DEV], SIG), fill, SIG)
    expect(once.bodyMd).toBe(`Hi —\n\n${SIG}`)
    const twice = withTemplate(once, { ...fill, bodyMd: 'Hello again —' }, SIG)
    expect(twice.bodyMd).toBe(`Hello again —\n\n${SIG}`)
    // A template saved from a signed draft already carries it.
    const carried = withTemplate(
      once,
      { ...fill, bodyMd: `Hi —\n\n${SIG}` },
      SIG,
    )
    expect(carried.bodyMd).toBe(`Hi —\n\n${SIG}`)
    // A template applied to an empty body leaves the blank line for the caret.
    expect(
      withTemplate(blankDraft('d2', [], SIG), { ...fill, bodyMd: '' }, SIG)
        .bodyMd,
    ).toBe(`\n\n${SIG}`)
  })

  it('is not put back by a template once the author deleted it', () => {
    const deleted = { ...blankDraft('d1', [DEV], SIG), bodyMd: 'Typed.' }
    const fill = { subject: 'Next steps', bodyMd: 'Hi —', attachments: [] }
    expect(withTemplate(deleted, fill, SIG).bodyMd).toBe('Hi —')
  })

  it('adds nothing when empty', () => {
    for (const empty of ['', '  \n ', null]) {
      expect(blankDraft('d1', [], empty).bodyMd).toBe('')
      expect(replyDraft('d1', modes.reply, empty).bodyMd).toBe('')
      expect(replyDraft('d1', modes.forward, empty).bodyMd).toBe(QUOTE)
      expect(
        withTemplate(
          blankDraft('d1', [], empty),
          { subject: 'S', bodyMd: 'Hi —', attachments: [] },
          empty,
        ).bodyMd,
      ).toBe('Hi —')
    }
  })

  it('is not added again to a held draft reopened', () => {
    const held = {
      ...blankDraft('d1', [DEV], SIG),
      bodyMd: 'Signature deleted.',
      updatedAt: '2026-11-20T10:58:00.000Z',
      sendError: null,
    }
    expect(draftStateOf(held).bodyMd).toBe('Signature deleted.')
  })

  it('alone is not a written body, so a template replaces it without asking', () => {
    expect(bodyWritten(`\n\n${SIG}`, SIG)).toBe(false)
    expect(bodyWritten(`Hi\n\n${SIG}`, SIG)).toBe(true)
    expect(bodyWritten('', '')).toBe(false)
    expect(bodyWritten(`\n\n${SIG}`, '')).toBe(true)
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

describe('Reconnect Gmail’s return', () => {
  const D = '00000000-0000-4000-8000-0000000000d1'

  it('comes back to the page that already opens the draft, marked', () => {
    expect(
      reconnectReturn('here', D, {
        pathname: '/email',
        search: `?tab=drafts&id=${D}`,
      }),
    ).toBe(`/email?tab=drafts&id=${D}&reconnected=gmail`)
  })

  it('opens a reply on a record in its own window on Interactions', () => {
    expect(
      reconnectReturn('record', D, {
        pathname: '/companies/c1',
        search: '?modal=email&id=m1',
      }),
    ).toBe(
      `/companies/c1?tab=interactions&modal=email&new=1&draft=${D}&reconnected=gmail`,
    )
  })

  it('sends a draft with no page of its own to the Email page’s window', () => {
    expect(
      reconnectReturn('email', D, { pathname: '/today', search: '' }),
    ).toBe(`/email?modal=email&new=1&draft=${D}&reconnected=gmail`)
  })

  it('asks Google for the sending mailbox, back to an in-app path', () => {
    const href = new URL(
      reconnectHref('anish@fund.example', 'email', D, {
        pathname: '/today',
        search: '',
      }),
      'http://x',
    )
    expect(href.pathname).toBe('/api/connections/google/start')
    expect(href.searchParams.get('product')).toBe('gmail')
    expect(href.searchParams.get('account')).toBe('anish@fund.example')
    expect(href.searchParams.get('return')?.startsWith('/email?')).toBe(true)
  })
})
