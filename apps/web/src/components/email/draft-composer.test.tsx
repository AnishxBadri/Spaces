import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '#/components/ui/dialog'
import { EMAIL_DRAFTS_QUERY, blankDraft } from '#/lib/email/compose'
import type { DraftState } from '#/lib/email/compose'
import type { DraftRecipient } from '#/lib/server-fns'
import { DraftComposer } from './draft-composer'

/**
 * The composer: Cc and Bcc closed until asked for, a Bcc chip
 * that reads as hidden, the recipient search with the alias pick on the
 * chip, one save per pause rather than per keystroke, the save a close
 * leaves behind, a foot of Cancel and Review with ⌘↵ in its tooltip and
 * printed nowhere, and the tool row's Variable. Every send passes Review,
 * from the window, the Email page's pane and a reply card in its thread:
 * the email as the card it will become, a copy per To recipient with
 * variables, the blank flagged, and Send counting what goes and staying off
 * while a blank is open. A fill is saved on its To chip. Send hands the
 * draft's id and Review's fills over; a mailbox without `gmail.send` makes
 * Review's primary Reconnect Gmail; a failure keeps Review open and says
 * why. Saving, sending and deleting each mark the sidebar's drafts count
 * stale.
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
  listEmailVariables: vi.fn(),
  sendEmailDraft: vi.fn(),
}))
vi.mock('#/lib/server-fns', () => fns)

const ID = '00000000-0000-4000-8000-0000000000d1'

let host: HTMLDivElement
let root: Root
let closed = vi.fn<() => void>()
let queryClient = new QueryClient()

/** How many times the sidebar's drafts count was marked stale. */
const draftsInvalidated = (spy: ReturnType<typeof spyInvalidate>) =>
  spy.mock.calls.filter(
    ([filters]) => filters?.queryKey?.[0] === EMAIL_DRAFTS_QUERY,
  ).length
const spyInvalidate = () => vi.spyOn(queryClient, 'invalidateQueries')

type ReviewCall = {
  data: {
    to: Array<DraftRecipient>
    cc: Array<DraftRecipient>
    bcc: Array<DraftRecipient>
  }
}

/** A draft with no variables reviews as every recipient, nothing blank. */
const plainReview = ({ data }: ReviewCall) =>
  Promise.resolve({
    paths: [],
    rows: [...data.to, ...data.cc, ...data.bcc].map((r) => ({
      email: r.email,
      name: r.name ?? null,
      values: {},
      blanks: [],
    })),
  })

beforeEach(() => {
  queryClient = new QueryClient()
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
  fns.reviewEmailVariables.mockImplementation(plainReview)
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

/**
 * Waits for what a window draws a beat later (a menu, a confirm) instead of
 * counting ticks: under load five ticks are not always enough.
 */
async function until<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const got = read()
    if (got) return got
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  throw new Error('timed out waiting')
}

/** Where the composer stands: its own window, the Email page's pane, a thread. */
type Place = 'window' | 'pane' | 'thread'

function mount(initial: DraftState = blankDraft(ID), place: Place = 'window') {
  const composer =
    place === 'thread' ? (
      <DraftComposer
        card
        initial={initial}
        onClose={closed}
        above={<div data-card="earlier">Earlier message</div>}
      />
    ) : (
      <DraftComposer initial={initial} onClose={closed} />
    )
  const framed: ReactNode =
    place === 'pane' ? (
      <div data-draft-pane className="flex flex-col px-4 pb-4">
        {composer}
      </div>
    ) : (
      <Dialog open>
        <DialogContent size="l" flush={place === 'thread'}>
          {composer}
        </DialogContent>
      </Dialog>
    )
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>{framed}</QueryClientProvider>,
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
const foot = () => document.querySelector('[data-slot="dialog-footer"]')
const card = () => document.querySelector('[data-review-card]')
const footButtons = () =>
  [...(foot()?.querySelectorAll('button, a') ?? [])].map((b) =>
    b.textContent.trim(),
  )
const pressMeta = () =>
  act(() => {
    body()?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
      }),
    )
  })

/** Presses the composer's primary and waits for Review. */
async function review() {
  act(() => button('Review')?.click())
  await settle()
}

describe('the address block', () => {
  it('keeps Cc and Bcc closed when empty and opens each from the block', () => {
    mount()
    expect(lineInput('To')).not.toBeNull()
    expect(lineInput('Cc')).toBeNull()
    expect(lineInput('Bcc')).toBeNull()
    act(() => button('Bcc')?.click())
    expect(lineInput('Bcc')).not.toBeNull()
    expect(lineInput('Cc')).toBeNull()
    act(() => button('Cc')?.click())
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

  it('marks the drafts count stale once the save lands', async () => {
    vi.useFakeTimers()
    const invalidate = spyInvalidate()
    mount()
    type(body(), 'Thanks Dana')
    expect(draftsInvalidated(invalidate)).toBe(0)
    act(() => {
      vi.advanceTimersByTime(800)
    })
    await settle()
    expect(fns.saveEmailDraft).toHaveBeenCalledTimes(1)
    expect(draftsInvalidated(invalidate)).toBe(1)
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
  it('prints no key: Review carries ⌘↵ in its tooltip', () => {
    mount()
    expect(document.querySelectorAll('kbd')).toHaveLength(0)
    expect(button('Review')?.getAttribute('data-state')).toBe('closed')
    expect(button('Review')?.closest('[data-slot="dialog-footer"]')).not.toBe(
      null,
    )
  })

  it('is Cancel and Review: no Send, no Trash, no recipient count', async () => {
    mount({
      ...blankDraft(ID),
      to: [{ email: 'dana@flent.example' }],
    })
    await settle()
    expect(footButtons()).toEqual(['Cancel', 'Review'])
    expect(foot()?.textContent).not.toMatch(/recipient/)
    expect(button('Send')).toBeUndefined()
    expect(button('Trash')).toBeUndefined()
  })

  it('carries Template, Variable and the draft’s ··· in the tool row above the foot', () => {
    mount()
    const tools = document.querySelector('[data-tool-row]')
    expect(tools?.textContent).toContain('Template')
    expect(tools?.textContent).toContain('Variable')
    expect(
      tools?.querySelector('[aria-label="More for this draft"]'),
    ).not.toBeNull()
  })

  it('Variable writes a {{path}} from the shared grammar into the body', async () => {
    fns.listEmailVariables.mockResolvedValue([
      { path: 'name.first', label: 'First name' },
      { path: 'company.name', label: 'Company' },
    ])
    mount()
    type(body(), 'Hi ')
    act(() => button('Variable')?.click())
    await settle()
    const option = document.querySelector('[data-variable-option="name.first"]')
    if (!(option instanceof HTMLElement)) throw new Error('no option')
    act(() => option.click())
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      )?.value,
    ).toBe('Hi {{name.first}}')
    expect(button('Review')).not.toBeUndefined()
  })
})

describe('Delete draft', () => {
  it('deletes the draft from the ··· and marks the drafts count stale', async () => {
    const invalidate = spyInvalidate()
    mount()
    await settle()
    const more = document.querySelector('[aria-label="More for this draft"]')
    if (!more) throw new Error('no ···')
    act(() => {
      more.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    const item = await until(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (el) => el.textContent.trim() === 'Delete draft…',
      ),
    )
    act(() => item.click())
    const confirmDelete = await until(() => button('Delete'))
    act(() => confirmDelete.click())
    await until(() => fns.deleteEmailDraft.mock.calls.length > 0)
    await settle()
    expect(fns.deleteEmailDraft).toHaveBeenCalledWith({ data: { id: ID } })
    expect(draftsInvalidated(invalidate)).toBe(1)
    expect(closed).toHaveBeenCalledTimes(1)
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
  const KAVYA = { email: 'kavya@fund.example', name: 'Kavya Iyer' }
  const withVariables: DraftState = {
    ...blankDraft(ID),
    to: [DANA, ARJUN],
    bcc: [KAVYA],
    subject: 'Intro: {{company.name}}',
    bodyMd: 'Hi {{name.first}},',
  }
  const variableReview = {
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
      {
        email: KAVYA.email,
        name: 'Kavya Iyer',
        values: { 'company.name': null, 'name.first': null },
        blanks: ['company.name', 'name.first'],
      },
    ],
  }
  const row = (email: string) =>
    document.querySelector(`[data-review-row="${email}"]`)
  const sendButton = (label = 'Send') => button(label)

  it('shows one message as the card it will become, and sends it', async () => {
    const invalidate = spyInvalidate()
    mount({
      ...blankDraft(ID),
      to: [DANA],
      subject: 'Diligence next steps',
      bodyMd: 'Thanks Dana',
      attachments: [
        {
          documentId: 'f1',
          name: 'Diligence questions.docx',
          mime: null,
          sizeBytes: 62_000,
        },
      ],
    })
    await settle()
    await review()
    expect(fns.reviewEmailVariables).toHaveBeenCalledTimes(1)
    expect(card()?.querySelector('[data-sender-line]')?.textContent).toBe(
      'You → Dana Moreau',
    )
    expect(card()?.querySelector('[data-review-from]')?.textContent).toBe(
      'anish@fund.example',
    )
    expect(card()?.querySelector('[data-review-subject]')?.textContent).toBe(
      'Diligence next steps',
    )
    expect(card()?.querySelector('[data-review-body]')?.textContent).toBe(
      'Thanks Dana',
    )
    const file = card()?.querySelector('[data-review-file="f1"]')
    expect(file?.textContent).toContain('Diligence questions.docx')
    expect(file?.textContent).toContain('61 KB')
    // One message: no recipients list.
    expect(document.querySelector('[aria-label="Recipients"]')).toBeNull()
    expect(footButtons()).toEqual(['Back to draft', 'Send'])
    expect(foot()?.textContent).not.toContain('unsent')
    act(() => sendButton()?.click())
    await settle()
    expect(fns.saveEmailDraft).toHaveBeenCalledTimes(1)
    expect(fns.sendEmailDraft).toHaveBeenCalledWith({
      data: { draftId: ID, fills: {}, accepted: [] },
    })
    expect(closed).toHaveBeenCalledTimes(1)
    // Once for the save before the send, once for the send.
    expect(draftsInvalidated(invalidate)).toBe(2)
  })

  it('writes the cc and bcc on the header as the sender line does', async () => {
    mount({
      ...blankDraft(ID),
      to: [DANA],
      cc: [ARJUN],
      bcc: [KAVYA],
      bodyMd: 'Thanks',
    })
    await settle()
    await review()
    expect(card()?.querySelector('[data-sender-line]')?.textContent).toBe(
      'You → Dana Moreau, cc Arjun Rao, bcc Kavya Iyer',
    )
  })

  it('⌘↵ presses Review, then Send', async () => {
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    pressMeta()
    await settle()
    expect(card()).not.toBeNull()
    expect(fns.sendEmailDraft).not.toHaveBeenCalled()
    pressMeta()
    await settle()
    expect(fns.sendEmailDraft).toHaveBeenCalledTimes(1)
  })

  it('a copy each: the To on the left, the Bcc in graphite, the blank flagged, Send counting and off', async () => {
    fns.reviewEmailVariables.mockResolvedValue(variableReview)
    mount(withVariables)
    await settle()
    await review()
    expect(fns.reviewEmailVariables).toHaveBeenCalledWith({
      data: {
        to: [DANA, ARJUN],
        cc: [],
        bcc: [KAVYA],
        subject: 'Intro: {{company.name}}',
        bodyMd: 'Hi {{name.first}},',
      },
    })
    // Kavya is a Bcc: on every copy, never a copy of her own.
    expect(row(KAVYA.email)).toBeNull()
    const bcc = document.querySelector(`[data-review-bcc="${KAVYA.email}"]`)
    expect(bcc?.textContent).toBe('Kavya IyerBcc')
    expect(bcc?.className).toContain('text-graphite')
    expect(row(DANA.email)?.hasAttribute('data-flagged')).toBe(false)
    expect(row(ARJUN.email)?.hasAttribute('data-flagged')).toBe(true)
    expect(row(ARJUN.email)?.textContent).toBe('Arjun Rao1')
    expect(footButtons()).toEqual(['Back to draft', 'Send 2 emails'])
    expect(sendButton('Send 2 emails')?.disabled).toBe(true)
  })

  it('renders the copy each recipient gets: resolved as it goes, a blank amber', async () => {
    fns.reviewEmailVariables.mockResolvedValue(variableReview)
    mount(withVariables)
    await settle()
    await review()
    // The flagged copy opens first.
    expect(card()?.getAttribute('data-review-copy')).toBe(ARJUN.email)
    expect(card()?.querySelector('[data-sender-line]')?.textContent).toBe(
      'You → Arjun Rao, bcc Kavya Iyer',
    )
    expect(
      card()?.querySelector('[data-resolved="company.name"]')?.textContent,
    ).toBe('Northgate')
    expect(card()?.querySelector('[data-blank="name.first"]')).not.toBeNull()
    expect(
      card()?.querySelector('[data-fill-row="name.first"]')?.textContent,
    ).toContain('Leave blank')
    const dana = row(DANA.email)
    if (!(dana instanceof HTMLElement)) throw new Error('no row')
    act(() => dana.click())
    expect(card()?.getAttribute('data-review-copy')).toBe(DANA.email)
    expect(card()?.textContent).toContain('Intro: Flent')
    expect(card()?.textContent).toContain('Hi Dana,')
    expect(card()?.querySelector('[data-blank]')).toBeNull()
  })

  it('turns Send on once the blank is filled, and sends the fill with the draft', async () => {
    fns.reviewEmailVariables.mockResolvedValue(variableReview)
    mount(withVariables)
    await settle()
    await review()
    const cell = document.querySelector(
      'input[aria-label="name.first for Arjun Rao"]',
    )
    type(cell, 'Arjun')
    expect(row(ARJUN.email)?.hasAttribute('data-flagged')).toBe(false)
    expect(sendButton('Send 2 emails')?.disabled).toBe(false)
    type(cell, '  ')
    expect(sendButton('Send 2 emails')?.disabled).toBe(true)
    type(cell, 'Arjun')
    act(() => sendButton('Send 2 emails')?.click())
    await settle()
    // The fill rides on Arjun's To chip, so the save carries it too.
    expect(fns.saveEmailDraft).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: [DANA, { ...ARJUN, fills: { 'name.first': 'Arjun' } }],
      }),
    })
    expect(fns.sendEmailDraft).toHaveBeenCalledWith({
      data: {
        draftId: ID,
        fills: { [ARJUN.email]: { 'name.first': 'Arjun' } },
        accepted: [],
      },
    })
  })

  it('turns Send on once the blank is left blank, and ⌘↵ sends then', async () => {
    fns.reviewEmailVariables.mockResolvedValue(variableReview)
    mount(withVariables)
    await settle()
    await review()
    const tick = document.querySelector(
      '[aria-label="Leave the blanks for Arjun Rao empty"]',
    )
    if (!(tick instanceof HTMLElement)) throw new Error('no tick')
    act(() => tick.click())
    expect(row(ARJUN.email)?.hasAttribute('data-flagged')).toBe(false)
    expect(sendButton('Send 2 emails')?.disabled).toBe(false)
    pressMeta()
    await settle()
    expect(fns.saveEmailDraft).toHaveBeenCalled()
    expect(fns.sendEmailDraft).toHaveBeenCalledWith({
      data: { draftId: ID, fills: {}, accepted: [ARJUN.email] },
    })
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('one To recipient with variables is one card with its fill row', async () => {
    fns.reviewEmailVariables.mockResolvedValue({
      paths: ['name.first'],
      rows: [variableReview.rows[1]],
    })
    mount({ ...withVariables, to: [ARJUN], bcc: [] })
    await settle()
    await review()
    expect(document.querySelector('[aria-label="Recipients"]')).toBeNull()
    expect(card()?.querySelector('[data-fill-row="name.first"]')).not.toBeNull()
    expect(footButtons()).toEqual(['Back to draft', 'Send'])
    expect(sendButton()?.disabled).toBe(true)
  })

  it('names a variable no attribute matches and stays on the draft', async () => {
    fns.reviewEmailVariables.mockRejectedValue(
      new Error('No attribute matches {{favourite_colour}}'),
    )
    mount({ ...withVariables, bodyMd: 'Hi {{favourite_colour}}' })
    await settle()
    await review()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'No attribute matches {{favourite_colour}}',
    )
    expect(document.querySelector('section[aria-label="Review"]')).toBeNull()
    expect(footButtons()).toEqual(['Cancel', 'Review'])
  })

  it('Back returns to the draft and keeps the fills', async () => {
    fns.reviewEmailVariables.mockResolvedValue(variableReview)
    mount(withVariables)
    await settle()
    await review()
    type(
      document.querySelector('input[aria-label="name.first for Arjun Rao"]'),
      'Arjun',
    )
    act(() => button('Back to draft')?.click())
    expect(document.querySelector('section[aria-label="Review"]')).toBeNull()
    expect(card()).toBeNull()
    await review()
    expect(sendButton('Send 2 emails')?.disabled).toBe(false)
  })

  it('reopens a draft with its fills: they were saved on the To chips', async () => {
    fns.reviewEmailVariables.mockResolvedValue(variableReview)
    mount({
      ...withVariables,
      to: [DANA, { ...ARJUN, fills: { 'name.first': 'Arjun' } }],
    })
    await settle()
    await review()
    expect(row(ARJUN.email)?.hasAttribute('data-flagged')).toBe(false)
    expect(sendButton('Send 2 emails')?.disabled).toBe(false)
    const arjun = row(ARJUN.email)
    if (!(arjun instanceof HTMLElement)) throw new Error('no row')
    act(() => arjun.click())
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="name.first for Arjun Rao"]',
      )?.value,
    ).toBe('Arjun')
    expect(
      card()?.querySelector('[data-resolved="name.first"]')?.textContent,
    ).toBe('Arjun')
  })

  it('reviews in the Email page’s pane, with no window behind it', async () => {
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' }, 'pane')
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(footButtons()).toEqual(['Cancel', 'Review'])
    await review()
    const pane = document.querySelector('[data-draft-pane]')
    expect(pane?.querySelector('section[aria-label="Review"]')).not.toBeNull()
    expect(pane?.querySelector('[data-review-card]')).not.toBeNull()
    expect(footButtons()).toEqual(['Back to draft', 'Send'])
    act(() => sendButton()?.click())
    await settle()
    expect(fns.sendEmailDraft).toHaveBeenCalledTimes(1)
  })

  it('reviews a reply in its thread: the draft card turns into the card as it goes', async () => {
    mount(
      {
        ...blankDraft(ID),
        mode: 'reply',
        subject: 'Re: Series A data room access',
        to: [DANA],
        cc: [ARJUN],
        bodyMd: 'Thanks Dana, got it.',
      },
      'thread',
    )
    await settle()
    expect(document.querySelector('[data-draft-card]')).not.toBeNull()
    expect(footButtons()).toEqual(['Cancel', 'Review'])
    await review()
    // The thread above stays; the draft card gives way to the review card.
    expect(document.querySelector('[data-card="earlier"]')).not.toBeNull()
    expect(
      document.querySelector('[data-draft-card]')?.classList.contains('hidden'),
    ).toBe(true)
    expect(card()?.querySelector('[data-sender-line]')?.textContent).toBe(
      'You → Dana Moreau, cc Arjun Rao',
    )
    // The thread's head carries the subject.
    expect(card()?.querySelector('[data-review-subject]')).toBeNull()
    expect(footButtons()).toEqual(['Back to draft', 'Send'])
  })
})

describe('Send', () => {
  const DANA = {
    email: 'dana@flent.example',
    entityId: '00000000-0000-4000-8000-0000000000e2',
    name: 'Dana Moreau',
  }
  const CONNECTION = '00000000-0000-4000-8000-0000000000c1'

  it('reviews without a mailbox that can send, and Review’s primary is Reconnect Gmail', async () => {
    fns.getEmailSender.mockResolvedValue({
      _tag: 'reconnect',
      from: 'anish@fund.example',
      connectionId: CONNECTION,
    })
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    expect(footButtons()).toEqual(['Cancel', 'Review'])
    await review()
    expect(button('Send')).toBeUndefined()
    const primary = document.querySelector('[data-reconnect]')
    expect(primary?.textContent).toBe('Reconnect Gmail')
    // Google's consent for that mailbox, back to this page and draft.
    const href = new URL(primary?.getAttribute('href') ?? '', 'http://x')
    expect(href.pathname).toBe('/api/connections/google/start')
    expect(href.searchParams.get('product')).toBe('gmail')
    expect(href.searchParams.get('account')).toBe('anish@fund.example')
    expect(href.searchParams.get('return')).toBe('/today?reconnected=gmail')
    pressMeta()
    await settle()
    expect(fns.sendEmailDraft).not.toHaveBeenCalled()
  })

  it('links to connecting Gmail where Send would stand when there is no mailbox', async () => {
    fns.getEmailSender.mockResolvedValue({
      _tag: 'unavailable',
      reason: 'Connect Gmail to send',
      href: '/settings/email-calendar',
    })
    mount({ ...blankDraft(ID), to: [DANA] })
    await settle()
    expect(button('Review')?.disabled).toBe(false)
    expect(document.querySelector('[data-send-blocked]')).toBeNull()
    await review()
    expect(card()).not.toBeNull()
    expect(button('Send')).toBeUndefined()
    // No mailbox, no sending address on the card.
    expect(card()?.querySelector('[data-review-from]')).toBeNull()
    const link = document.querySelector('[data-send-blocked]')
    expect(link?.getAttribute('href')).toBe('/settings/email-calendar')
    expect(link?.textContent).toBe('Connect Gmail to send ›')
  })

  it('keeps Review open with Gmail’s words when the send fails', async () => {
    fns.sendEmailDraft.mockRejectedValue(
      new Error('Gmail answered 503: Backend Error'),
    )
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    await review()
    act(() => button('Send')?.click())
    await settle()
    expect(document.querySelector('[data-send-failed]')?.textContent).toBe(
      'Not sent · Gmail answered 503: Backend Error',
    )
    expect(closed).not.toHaveBeenCalled()
    expect(fns.deleteEmailDraft).not.toHaveBeenCalled()
    expect(card()).not.toBeNull()
    expect(footButtons()).toEqual(['Back to draft', 'Retry'])
    // Retry sends the reviewed draft again.
    fns.sendEmailDraft.mockResolvedValue({ sent: 1, interactionIds: ['i1'] })
    act(() => button('Retry')?.click())
    await settle()
    expect(fns.sendEmailDraft).toHaveBeenCalledTimes(2)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('says a stored failure in the foot when the draft opens again, and Review offers Retry', async () => {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Dialog open>
            <DialogContent size="l">
              <DraftComposer
                initial={{ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks' }}
                notSent="Gmail didn’t answer"
                onClose={closed}
              />
            </DialogContent>
          </Dialog>
        </QueryClientProvider>,
      ),
    )
    await settle()
    expect(document.querySelector('[data-send-failed]')?.textContent).toBe(
      'Not sent · Gmail didn’t answer',
    )
    await review()
    expect(footButtons()).toEqual(['Back to draft', 'Retry'])
  })

  it('back from Reconnect Gmail opens on Review with Send and no note', async () => {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Dialog open>
            <DialogContent size="l">
              <DraftComposer
                initial={{ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks' }}
                notSent="Gmail asks you to sign in again"
                reconnected
                onClose={closed}
              />
            </DialogContent>
          </Dialog>
        </QueryClientProvider>,
      ),
    )
    await settle()
    expect(card()).not.toBeNull()
    expect(document.querySelector('[data-send-failed]')).toBeNull()
    expect(footButtons()).toEqual(['Back to draft', 'Send'])
  })

  it('greys the draft while it goes, says it goes through Gmail, and holds Back to draft', async () => {
    let finish: (v: {
      sent: number
      interactionIds: Array<string>
    }) => void = () => {}
    fns.sendEmailDraft.mockReturnValue(
      new Promise((r) => {
        finish = r
      }),
    )
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    await review()
    act(() => button('Send')?.click())
    await settle()
    // The primary twinkles `Sending`; the foot says nothing else.
    const primary = foot()?.querySelector('[data-pending]')
    expect(primary?.textContent).toBe('Sending')
    expect(primary?.querySelector('[data-twinkle]')).not.toBeNull()
    expect(foot()?.querySelector('[data-send-failed]')).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(button('Back to draft')?.disabled).toBe(true)
    await act(async () => finish({ sent: 1, interactionIds: ['i1'] }))
    await settle()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('asks to reconnect when Gmail refuses the token, and keeps the draft', async () => {
    fns.sendEmailDraft.mockRejectedValue(new Error('Gmail refused the token'))
    mount({ ...blankDraft(ID), to: [DANA], bodyMd: 'Thanks Dana' })
    await settle()
    await review()
    fns.getEmailSender.mockResolvedValue({
      _tag: 'reconnect',
      from: 'anish@fund.example',
      connectionId: CONNECTION,
    })
    act(() => button('Send')?.click())
    await settle()
    expect(document.querySelector('[data-send-failed]')?.textContent).toBe(
      'Not sent · Gmail asks you to sign in again',
    )
    expect(document.querySelector('[data-reconnect]')?.textContent).toBe(
      'Reconnect Gmail',
    )
    expect(fns.deleteEmailDraft).not.toHaveBeenCalled()
  })
})
