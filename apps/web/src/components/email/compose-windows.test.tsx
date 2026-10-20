import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftRow } from '#/lib/server-fns'
import { DraftsDialog, recipientsLine } from './compose-windows'

/**
 * The drafts list (D67, E5): only what the server lists for the viewer,
 * `(no subject)` for a draft without one, and Trash on the row's end.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/today' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'Node',
    'NodeFilter',
    'Element',
    'SVGElement',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLIFrameElement',
    'Text',
    'DocumentFragment',
    'ShadowRoot',
    'Event',
    'CustomEvent',
    'UIEvent',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const fns = vi.hoisted(() => ({
  listEmailDrafts: vi.fn(),
  getEmailSender: vi.fn(),
  deleteEmailDraft: vi.fn(),
  getEmailDraft: vi.fn(),
  saveEmailDraft: vi.fn(),
  listRecordDocuments: vi.fn(),
  searchEmailRecipients: vi.fn(),
  finalizeDocumentUpload: vi.fn(),
  prepareDocumentUpload: vi.fn(),
}))
vi.mock('#/lib/server-fns', () => fns)

const ROWS: Array<DraftRow> = [
  {
    id: '00000000-0000-4000-8000-0000000000d1',
    mode: 'reply_all',
    subject: 'Re: Sept cap table + data room access',
    to: [
      { email: 'dana@flent.example', name: 'Dana Moreau' },
      { email: 'arjun@flent.example' },
      { email: 'kiran@flent.example' },
    ],
    updatedAt: '2026-10-19T09:16:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-0000000000d2',
    mode: 'new',
    subject: '',
    to: [],
    updatedAt: '2026-09-27T10:00:00.000Z',
  },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset()
  fns.listEmailDrafts.mockResolvedValue(ROWS)
  fns.deleteEmailDraft.mockResolvedValue({ ok: true })
  fns.getEmailSender.mockResolvedValue({
    _tag: 'ready',
    from: 'anish@fund.example',
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const settle = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}

const rows = () =>
  [...document.querySelectorAll('[data-draft]')].map((r) => r.textContent)

describe('the drafts list', () => {
  it('lists the viewer’s drafts with mode, recipients and the empty subject', async () => {
    act(() => root.render(<DraftsDialog open onOpenChange={() => {}} />))
    await settle()
    expect(fns.listEmailDrafts).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(2)
    expect(rows()[0]).toContain('reply all')
    expect(rows()[0]).toContain('Dana Moreau +2')
    expect(rows()[1]).toContain('(no subject)')
    expect(
      document.querySelector('[data-slot="dialog-description"]')?.textContent,
    ).toBe('2 · only yours')
  })

  it('trashes a row from its end and drops it from the list', async () => {
    act(() => root.render(<DraftsDialog open onOpenChange={() => {}} />))
    await settle()
    const trash = document.querySelector(
      'button[aria-label="Trash Re: Sept cap table + data room access"]',
    )
    if (!(trash instanceof HTMLElement)) throw new Error('no trash')
    act(() => trash.click())
    await settle()
    expect(fns.deleteEmailDraft).toHaveBeenCalledWith({
      data: { id: '00000000-0000-4000-8000-0000000000d1' },
    })
    expect(rows()).toHaveLength(1)
  })

  it('reads the recipients as one name and a count', () => {
    expect(recipientsLine([])).toBe('—')
    expect(recipientsLine([{ email: 'a@x.example' }])).toBe('a@x.example')
  })
})
