import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '#/components/ui/dialog'
import { blankDraft } from '#/lib/email/compose'
import type { DraftState } from '#/lib/email/compose'
import { DraftComposer } from './draft-composer'

/**
 * The composer (D67, E3/E4): Cc and Bcc closed until asked for, a Bcc chip
 * that reads as hidden, the recipient search with the alias pick on the
 * chip, one save per pause rather than per keystroke, the save a close
 * leaves behind, Trash, ⌘↵ as the one printed key, and Review: a draft with
 * variables shows recipients × variables with blanks flagged, and Send is
 * absent until each blank is filled or accepted. Send hands the draft's id
 * and Review's fills over; a mailbox without `gmail.send` has no Send and
 * names the account to reconnect; a failure keeps the composer open.
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
  saveEmailDraft: vi.fn(),
  deleteEmailDraft: vi.fn(),
  listRecordDocuments: vi.fn(),
  searchEmailRecipients: vi.fn(),
  finalizeDocumentUpload: vi.fn(),
  prepareDocumentUpload: vi.fn(),
  reviewEmailVariables: vi.fn(),
  getEmailTemplate: vi.fn(),
  saveEmailAsTemplate: vi.fn(),
  listTemplates: vi.fn(),
  getEmailSender: vi.fn(),
  sendEmailDraft: vi.fn(),
}))
vi.mock('#/lib/server-fns', () => fns)

const ID = '00000000-0000-4000-8000-0000000000d1'

let host: HTMLDivElement
let root: Root
let closed = vi.fn<() => void>()

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset()
  fns.saveEmailDraft.mockResolvedValue({
    id: ID,
    updatedAt: '2026-10-19T09:16:00.000Z',
  })
  fns.deleteEmailDraft.mockResolvedValue({ ok: true })
  fns.searchEmailRecipients.mockResolvedValue([])
  fns.getEmailSender.mockResolvedValue({
    _tag: 'ready',
    from: 'anish@fund.example',
  })
  fns.sendEmailDraft.mockResolvedValue({ sent: 1, interactionIds: ['i1'] })
  closed = vi.fn<() => void>()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const settle = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await Promise.resolve()
    })
}

function mount(initial: DraftState = blankDraft(ID)) {
  act(() =>
    root.render(
      <Dialog open>
        <DialogContent>
          <DraftComposer initial={initial} onClose={closed} />
        </DialogContent>
      </Dialog>,
    ),
  )
}

/** Types into a controlled field the way a keystroke does. */
function type(el: Element | null, value: string) {
  if (el instanceof HTMLTextAreaElement)
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(el, value)
  else if (el instanceof HTMLInputElement)
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(el, value)
  else throw new Error('not a field')
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const body = () => document.querySelector('textarea[aria-label="Message"]')
const lineInput = (label: string) =>
  document.querySelector(`input[aria-label^="${label} —"]`)
const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === label,
  )

describe('the address block', () => {
  it('keeps Cc and Bcc closed when empty and opens each from the block', () => {
    mount()
    expect(lineInput('To')).not.toBeNull()
    expect(lineInput('Cc')).toBeNull()
    expect(lineInput('Bcc')).toBeNull()
    act(() => button('bcc')?.click())
    expect(lineInput('Bcc')).not.toBeNull()
    expect(lineInput('Cc')).toBeNull()
    act(() => button('cc')?.click())
    expect(lineInput('Cc')).not.toBeNull()
  })

  it('opens a line that holds someone, and a Bcc chip reads as hidden', () => {
    mount({
      ...blankDraft(ID),
      cc: [{ email: 'kiran@flent.example' }],
      bcc: [
        {
          email: 'priya@fund.example',
          entityId: '00000000-0000-4000-8000-0000000000e1',
          name: 'Priya Nair',
        },
      ],
    })
    expect(lineInput('Cc')).not.toBeNull()
    const chip = document.querySelector('[data-chip="priya@fund.example"]')
    expect(chip?.textContent).toContain('Priya Nair')
    expect(chip?.textContent).toContain('hidden')
    const cc = document.querySelector('[data-chip="kiran@flent.example"]')
    expect(cc?.textContent).toContain('new')
    expect(cc?.textContent).not.toContain('hidden')
  })

  it('searches people by name and alias, and the chip picks which alias', async () => {
    vi.useFakeTimers()
    fns.searchEmailRecipients.mockResolvedValue([
      {
        entityId: '00000000-0000-4000-8000-0000000000e2',
        name: 'Dana Moreau',
        emails: ['dana@flent.example', 'dana.moreau@gmail.example'],
      },
    ])
    mount()
    type(lineInput('To'), 'dana')
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await settle()
    expect(fns.searchEmailRecipients).toHaveBeenCalledWith({
      data: { q: 'dana' },
    })
    const option = [...document.querySelectorAll('[role="option"] button')].at(
      0,
    )
    if (!(option instanceof HTMLElement)) throw new Error('no match')
    act(() => option.click())
    const chip = document.querySelector('[data-chip="dana@flent.example"]')
    expect(chip?.textContent).toContain('Dana Moreau')
    expect(
      chip?.querySelector('[aria-label="Which address for Dana Moreau"]'),
    ).not.toBeNull()
  })

  it('takes a typed address no one holds as a new chip', () => {
    mount()
    const input = lineInput('To')
    type(input, 'ops@northgate.example')
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    const chip = document.querySelector('[data-chip="ops@northgate.example"]')
    expect(chip?.textContent).toContain('new')
  })
})

describe('the autosave', () => {
  it('writes once after the pause, never on every keystroke', async () => {
    vi.useFakeTimers()
    mount()
    expect(fns.saveEmailDraft).not.toHaveBeenCalled()
    type(body(), 'T')
    act(() => {
      vi.advanceTimersByTime(300)
    })
    type(body(), 'Th')
    act(() => {
      vi.advanceTimersByTime(300)
    })
    type(body(), 'Thanks Dana')
    act(() => {
      vi.advanceTimersByTime(799)
    })
    expect(fns.saveEmailDraft).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    await settle()
    expect(fns.saveEmailDraft).toHaveBeenCalledTimes(1)
    expect(fns.saveEmailDraft).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: ID, bodyMd: 'Thanks Dana' }),
    })
  })

  it('writes nothing for a draft only opened', async () => {
    vi.useFakeTimers()
    mount()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    await settle()
    expect(fns.saveEmailDraft).not.toHaveBeenCalled()
  })

  it('saves what was typed when the window closes before the pause', () => {
    vi.useFakeTimers()
    mount()
    type(body(), 'Two questions on the ESOP top-up')
    act(() => root.unmount())
    root = createRoot(host)
    expect(fns.saveEmailDraft).toHaveBeenCalledTimes(1)
    expect(fns.saveEmailDraft).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bodyMd: 'Two questions on the ESOP top-up',
      }),
    })
  })
})

describe('the foot', () => {
  it('prints ⌘↵ on Send and no other key', () => {
    mount()
    const keys = [...document.querySelectorAll('kbd')].map((k) => k.textContent)
    expect(keys).toEqual(['⌘↵'])
    expect(button('Send⌘↵')?.closest('[data-slot="dialog-footer"]')).not.toBe(
      null,
    )
  })

  it('Trash deletes the row and closes, and leaves nothing to save', async () => {
    vi.useFakeTimers()
    mount()
    type(body(), 'never mind')
    act(() => button('Trash')?.click())
    await settle()
    expect(fns.deleteEmailDraft).toHaveBeenCalledWith({ data: { id: ID } })
    expect(closed).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    root = createRoot(host)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(fns.saveEmailDraft).not.toHaveBeenCalled()
  })
})

describe('Review', () => {
  const DANA = {
    email: 'dana@flent.example',
    entityId: '00000000-0000-4000-8000-0000000000e2',
    name: 'Dana Moreau',
  }
  const ARJUN = {
    email: 'arjun@northgate.example',
    entityId: '00000000-0000-4000-8000-0000000000e3',
    name: 'Arjun Rao',
  }
  const withVariables: DraftState = {
    ...blankDraft(ID),
    to: [DANA, ARJUN],
    subject: 'Intro: {{company.name}}',
    bodyMd: 'Hi {{name.first}},',
  }
  const review = {
    paths: ['company.name', 'name.first'],
    rows: [
      {
        email: DANA.email,
        name: 'Dana Moreau',
        values: { 'company.name': 'Flent', 'name.first': 'Dana' },
        blanks: [],
      },
      {
        email: ARJUN.email,
        name: 'Arjun Rao',
        values: { 'company.name': 'Northgate', 'name.first': null },
        blanks: ['name.first'],
      },
    ],
  }
  const row = (email: string) =>
    document.querySelector(`[data-review-row="${email}"]`)
  const sendButton = () => button('Send⌘↵')

  it('sends a draft with no variables without a Review', async () => {
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    expect(button('Review⌘↵')).toBeUndefined()
    act(() => sendButton()?.click())
    await settle()
    expect(fns.reviewEmailVariables).not.toHaveBeenCalled()
    expect(fns.saveEmailDraft).toHaveBeenCalledTimes(1)
    expect(fns.sendEmailDraft).toHaveBeenCalledWith({
      data: { draftId: ID, fills: {}, accepted: [] },
    })
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('reviews a draft with variables and flags the blank row; Send is absent', async () => {
    fns.reviewEmailVariables.mockResolvedValue(review)
    mount(withVariables)
    await settle()
    expect(sendButton()).toBeUndefined()
    act(() => button('Review⌘↵')?.click())
    await settle()
    expect(fns.reviewEmailVariables).toHaveBeenCalledWith({
      data: {
        to: [DANA, ARJUN],
        cc: [],
        bcc: [],
        subject: 'Intro: {{company.name}}',
        bodyMd: 'Hi {{name.first}},',
      },
    })
    const heads = [...document.querySelectorAll('[data-variable]')].map(
      (h) => h.textContent,
    )
    expect(heads).toContain('{{company.name}}')
    expect(heads).toContain('{{name.first}}')
    expect(row(DANA.email)?.hasAttribute('data-flagged')).toBe(false)
    expect(row(ARJUN.email)?.hasAttribute('data-flagged')).toBe(true)
    expect(row(ARJUN.email)?.textContent).toContain('1 blank')
    expect(sendButton()).toBeUndefined()
    expect(document.querySelector('[data-open-blanks]')?.textContent).toBe(
      '1 blank to fill',
    )
  })

  it('shows Send once the blank is filled, and sends the fill with the draft', async () => {
    fns.reviewEmailVariables.mockResolvedValue(review)
    mount(withVariables)
    await settle()
    act(() => button('Review⌘↵')?.click())
    await settle()
    const cell = document.querySelector(
      'input[aria-label="name.first for Arjun Rao"]',
    )
    type(cell, 'Arjun')
    expect(row(ARJUN.email)?.hasAttribute('data-flagged')).toBe(false)
    expect(sendButton()).not.toBeUndefined()
    type(cell, '  ')
    expect(sendButton()).toBeUndefined()
    type(cell, 'Arjun')
    act(() => sendButton()?.click())
    await settle()
    expect(fns.sendEmailDraft).toHaveBeenCalledWith({
      data: {
        draftId: ID,
        fills: { [ARJUN.email]: { 'name.first': 'Arjun' } },
        accepted: [],
      },
    })
  })

  it('shows Send once the blank is accepted, and ⌘↵ sends then', async () => {
    fns.reviewEmailVariables.mockResolvedValue(review)
    mount(withVariables)
    await settle()
    act(() => button('Review⌘↵')?.click())
    await settle()
    const tick = document.querySelector(
      '[aria-label="Leave the blanks for Arjun Rao empty"]',
    )
    if (!(tick instanceof HTMLElement)) throw new Error('no tick')
    act(() => tick.click())
    expect(row(ARJUN.email)?.hasAttribute('data-flagged')).toBe(false)
    expect(sendButton()).not.toBeUndefined()
    act(() => {
      body()?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
        }),
      )
    })
    await settle()
    expect(fns.saveEmailDraft).toHaveBeenCalled()
    expect(fns.sendEmailDraft).toHaveBeenCalledWith({
      data: { draftId: ID, fills: {}, accepted: [ARJUN.email] },
    })
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('names a variable no attribute matches and stays on the draft', async () => {
    fns.reviewEmailVariables.mockRejectedValue(
      new Error('No attribute matches {{favourite_colour}}'),
    )
    mount({ ...withVariables, bodyMd: 'Hi {{favourite_colour}}' })
    await settle()
    act(() => button('Review⌘↵')?.click())
    await settle()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'No attribute matches {{favourite_colour}}',
    )
    expect(document.querySelector('section[aria-label="Review"]')).toBeNull()
    expect(sendButton()).toBeUndefined()
  })

  it('Back returns to the draft and keeps the fills', async () => {
    fns.reviewEmailVariables.mockResolvedValue(review)
    mount(withVariables)
    await settle()
    act(() => button('Review⌘↵')?.click())
    await settle()
    type(
      document.querySelector('input[aria-label="name.first for Arjun Rao"]'),
      'Arjun',
    )
    act(() => button('Back')?.click())
    expect(document.querySelector('section[aria-label="Review"]')).toBeNull()
    act(() => button('Review⌘↵')?.click())
    await settle()
    expect(sendButton()).not.toBeUndefined()
  })
})

describe('Send', () => {
  const DANA = {
    email: 'dana@flent.example',
    entityId: '00000000-0000-4000-8000-0000000000e2',
    name: 'Dana Moreau',
  }
  const CONNECTION = '00000000-0000-4000-8000-0000000000c1'

  it('is absent when the mailbox lacks gmail.send, and the line names Gmail and its account page', async () => {
    fns.getEmailSender.mockResolvedValue({
      _tag: 'reconnect',
      from: 'anish@fund.example',
      connectionId: CONNECTION,
    })
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    expect(button('Send⌘↵')).toBeUndefined()
    const line = document.querySelector('[data-send-blocked]')
    expect(line?.textContent).toBe('Reconnect Gmail to send ›')
    expect(line?.getAttribute('href')).toBe(
      `/settings/email-calendar/${CONNECTION}`,
    )
    act(() => {
      body()?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
        }),
      )
    })
    await settle()
    expect(fns.sendEmailDraft).not.toHaveBeenCalled()
  })

  it('says to connect Gmail when there is no mailbox at all', async () => {
    fns.getEmailSender.mockResolvedValue({
      _tag: 'unavailable',
      reason: 'Connect Gmail to send',
      href: '/settings/email-calendar',
    })
    mount({ ...blankDraft(ID), to: [DANA] })
    await settle()
    expect(button('Send⌘↵')).toBeUndefined()
    expect(
      document.querySelector('[data-send-blocked]')?.getAttribute('href'),
    ).toBe('/settings/email-calendar')
  })

  it('keeps the composer open with Gmail’s words when the send fails', async () => {
    fns.sendEmailDraft.mockRejectedValue(
      new Error('Gmail answered 503: Backend Error. The draft is kept'),
    )
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    act(() => button('Send⌘↵')?.click())
    await settle()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Gmail answered 503: Backend Error. The draft is kept',
    )
    expect(closed).not.toHaveBeenCalled()
    expect(fns.deleteEmailDraft).not.toHaveBeenCalled()
    expect(button('Send⌘↵')).not.toBeUndefined()
  })
})
