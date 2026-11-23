import { describe, expect, it, vi } from 'vitest'
import { blankDraft, emailRecordAction, withTemplate } from './compose'

/**
 * A new email's seams: the blank draft with a record's To, a template
 * applied over it keeping the recipients, and Cmd-K's `Email <name>`.
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
