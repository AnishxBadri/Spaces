import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposeOpening, EmailDraft } from '#/lib/server-fns'
import { ComposeModal } from './compose-windows'

/**
 * The composer a page opens over itself from `?modal=email&new=1&draft=`:
 * a new email under the URL's id with To from the record, a template
 * applied as it opens, a held draft reopened as it was, an id minted into a
 * URL without one, and Esc or Cancel dropping the keys. The head is the
 * mail glyph and the subject, the foot the saved line, Cancel and Review;
 * Review shows the email on bone, and a fill made there is still there when
 * the window is closed and the draft opened again.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/flent' })
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

const DRAFT = '00000000-0000-4000-8000-0000000000d1'
const RECORD = '00000000-0000-4000-8000-0000000000aa'
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1'

const fns = vi.hoisted(() => ({
  openEmailCompose: vi.fn(),
  getEmailTemplate: vi.fn(),
  getEmailSender: vi.fn(),
  saveEmailDraft: vi.fn(),
  deleteEmailDraft: vi.fn(),
  searchEmailRecipients: vi.fn(),
  listRecordDocuments: vi.fn(),
  listEmailVariables: vi.fn(),
  listTemplates: vi.fn(),
  reviewEmailVariables: vi.fn(),
  sendEmailDraft: vi.fn(),
}))
const router = vi.hoisted(() => {
  const search: Record<string, unknown> = {}
  return { navigate: vi.fn(), search }
})

const toasts = vi.hoisted(() => {
  const said: Array<string> = []
  return { said }
})

vi.mock('#/lib/server-fns', () => fns)
vi.mock('sonner', () => ({
  toast: Object.assign(
    (text: string) => {
      toasts.said.push(text)
    },
    { error: () => undefined },
  ),
}))
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
}))

const DEV = { email: 'dev@flent.example', entityId: 'p-dev', name: 'Dev Shah' }

const opening = (over: Partial<ComposeOpening> = {}): ComposeOpening => ({
  draft: null,
  to: [DEV],
  record: { id: RECORD, name: 'Flent' },
  ...over,
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset()
  router.navigate.mockReset()
  router.search = {}
  toasts.said.length = 0
  fns.openEmailCompose.mockResolvedValue(opening())
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

async function open(search: Record<string, unknown>) {
  router.search = search
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ComposeModal recordId={RECORD} />
      </QueryClientProvider>,
    ),
  )
  await settle()
}

const dialog = () => document.querySelector('[role="dialog"]')
const title = () =>
  dialog()?.querySelector('[data-slot="dialog-title"]')?.textContent
const chips = () =>
  [...(dialog()?.querySelectorAll('[data-chip]') ?? [])].map((c) =>
    c.getAttribute('data-chip'),
  )
const footButtons = () =>
  [
    ...(dialog()?.querySelectorAll('[data-slot="dialog-footer"] button') ?? []),
  ].map((b) => b.textContent.trim())

/** What the last navigation made of `prev`. */
function lastSearch(prev: Record<string, unknown>) {
  const call = router.navigate.mock.calls.at(-1)?.at(0)
  if (typeof call !== 'object' || call === null)
    throw new Error('no navigation')
  const reduce: unknown = Reflect.get(call, 'search')
  if (typeof reduce !== 'function') throw new Error('no search reducer')
  const next: unknown = reduce(prev)
  return next
}

describe('the composer over a page', () => {
  it('stays shut without ?modal=email&new=1', async () => {
    await open({ modal: 'email', id: DRAFT })
    expect(dialog()).toBeNull()
    expect(fns.openEmailCompose).not.toHaveBeenCalled()
  })

  it('opens a new email under the URL’s id, To from the record, head New email, foot Cancel and Review', async () => {
    await open({ tab: 'interactions', modal: 'email', new: 1, draft: DRAFT })
    expect(fns.openEmailCompose).toHaveBeenCalledWith({
      data: { draftId: DRAFT, recordId: RECORD },
    })
    expect(title()).toBe('New email')
    expect(chips()).toEqual(['dev@flent.example'])
    expect(footButtons()).toEqual(['Cancel', 'Review'])
    // Nothing is written until something is typed.
    expect(fns.saveEmailDraft).not.toHaveBeenCalled()
  })

  it('applies the URL’s template as it opens: the subject heads the window', async () => {
    fns.getEmailTemplate.mockResolvedValue({
      subject: 'Diligence next steps',
      bodyMd: 'Hi —',
      attachments: [],
    })
    await open({ modal: 'email', new: 1, draft: DRAFT, template: TEMPLATE })
    expect(fns.getEmailTemplate).toHaveBeenCalledWith({
      data: { id: TEMPLATE },
    })
    expect(title()).toBe('Diligence next steps')
    expect(chips()).toEqual(['dev@flent.example'])
    const body = dialog()?.querySelector('textarea')
    expect(body?.value).toBe('Hi —')
  })

  it('reopens a draft held under the URL’s id as it was, its saved line in the foot', async () => {
    const held: EmailDraft = {
      id: DRAFT,
      mode: 'new',
      inReplyToId: null,
      to: [{ email: 'priya@flent.example' }],
      cc: [],
      bcc: [],
      subject: 'Data room',
      bodyMd: 'The link.',
      attachments: [],
      updatedAt: '2026-11-20T10:58:00.000Z',
      sendError: null,
    }
    fns.openEmailCompose.mockResolvedValue(opening({ draft: held, to: [] }))
    await open({ modal: 'email', new: 1, draft: DRAFT, template: TEMPLATE })
    expect(fns.getEmailTemplate).not.toHaveBeenCalled()
    expect(title()).toBe('Data room')
    expect(chips()).toEqual(['priya@flent.example'])
    expect(
      dialog()?.querySelector('[data-slot="dialog-footer"] [data-saved]')
        ?.textContent,
    ).toMatch(/^Saved \d\d:\d\d$/)
  })

  it('mints the draft’s id into a URL that has none, and opens nothing until it has', async () => {
    await open({ tab: 'interactions', modal: 'email', new: 1 })
    expect(dialog()).toBeNull()
    expect(lastSearch({ tab: 'interactions', modal: 'email', new: 1 })).toEqual(
      {
        tab: 'interactions',
        modal: 'email',
        new: 1,
        draft: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    )
  })

  it('closes on Cancel to the page as it was: the compose keys go, the tab stays', async () => {
    await open({ tab: 'interactions', modal: 'email', new: 1, draft: DRAFT })
    const cancel = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Cancel',
    )
    act(() => cancel?.click())
    await settle()
    expect(
      lastSearch({
        tab: 'interactions',
        modal: 'email',
        new: 1,
        draft: DRAFT,
        template: TEMPLATE,
      }),
    ).toEqual({
      tab: 'interactions',
      modal: undefined,
      new: undefined,
      draft: undefined,
      template: undefined,
    })
  })
})

describe('Review in the window', () => {
  const PRIYA = { email: 'priya@flent.example', name: 'Priya Raman' }
  const held: EmailDraft = {
    id: DRAFT,
    mode: 'new',
    inReplyToId: null,
    to: [DEV, PRIYA],
    cc: [],
    bcc: [],
    subject: 'Diligence next steps',
    bodyMd: 'Hi {{name.first}},',
    attachments: [],
    updatedAt: '2026-11-20T10:58:00.000Z',
    sendError: null,
  }
  const review = {
    paths: ['name.first'],
    rows: [
      {
        email: DEV.email,
        name: 'Dev Shah',
        values: { 'name.first': 'Dev' },
        blanks: [],
      },
      {
        email: PRIYA.email,
        name: 'Priya Raman',
        values: { 'name.first': null },
        blanks: ['name.first'],
      },
    ],
  }
  const press = async (label: string) => {
    act(() =>
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === label)
        ?.click(),
    )
    await settle()
  }
  const fillCell = () =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="name.first for Priya Raman"]',
    )

  beforeEach(() => {
    fns.reviewEmailVariables.mockResolvedValue(review)
  })

  it('back from Reconnect Gmail: the draft opens on Review, no note, Send, and a toast', async () => {
    fns.openEmailCompose.mockResolvedValue(
      opening({
        draft: { ...held, sendError: 'Gmail asks you to sign in again' },
        to: [],
      }),
    )
    fns.reviewEmailVariables.mockResolvedValue({
      paths: [],
      rows: [DEV, PRIYA].map((r) => ({
        email: r.email,
        name: r.name,
        values: {},
        blanks: [],
      })),
    })
    await open({ modal: 'email', new: 1, draft: DRAFT, reconnected: 'gmail' })
    expect(dialog()?.querySelector('[data-review-card]')).not.toBeNull()
    expect(dialog()?.querySelector('[data-send-failed]')).toBeNull()
    expect(footButtons()).toEqual(['Back to draft', 'Send'])
    expect(toasts.said).toEqual(['Gmail reconnected'])
    // The key goes, so a reload does not say it again.
    expect(
      lastSearch({
        modal: 'email',
        new: 1,
        draft: DRAFT,
        reconnected: 'gmail',
      }),
    ).toEqual({ modal: 'email', new: 1, draft: DRAFT, reconnected: undefined })
  })

  it('a draft whose send failed reopens saying so', async () => {
    fns.openEmailCompose.mockResolvedValue(
      opening({ draft: { ...held, sendError: 'Gmail didn’t answer' }, to: [] }),
    )
    await open({ modal: 'email', new: 1, draft: DRAFT })
    expect(dialog()?.querySelector('[data-send-failed]')?.textContent).toBe(
      'Not sent · Gmail didn’t answer',
    )
    expect(toasts.said).toEqual([])
  })

  it('shows the email on bone under the head, a copy each, and counts the send', async () => {
    fns.openEmailCompose.mockResolvedValue(opening({ draft: held, to: [] }))
    await open({ modal: 'email', new: 1, draft: DRAFT })
    await press('Review')
    const ground = dialog()?.querySelector('section[aria-label="Review"]')
    expect(ground?.className).toContain('bg-bone')
    expect(
      dialog()?.querySelector('[data-review-card] [data-review-from]')
        ?.textContent,
    ).toBe('anish@fund.example')
    expect(footButtons()).toEqual(['Back to draft', 'Send 2 emails'])
  })

  it('keeps a fill made in Review when the window closes and the draft opens again', async () => {
    let saved: EmailDraft = held
    fns.saveEmailDraft.mockImplementation(
      ({ data }: { data: Omit<EmailDraft, 'updatedAt' | 'attachments'> }) => {
        saved = { ...data, attachments: [], updatedAt: held.updatedAt }
        return Promise.resolve({ id: DRAFT, updatedAt: held.updatedAt })
      },
    )
    fns.openEmailCompose.mockImplementation(() =>
      Promise.resolve(opening({ draft: saved, to: [] })),
    )
    await open({ modal: 'email', new: 1, draft: DRAFT })
    await press('Review')
    const cell = fillCell()
    if (cell === null) throw new Error('no fill row')
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(cell, 'Priya')
    act(() => {
      cell.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Closed before the autosave's pause: the close saves it.
    await open({})
    expect(dialog()).toBeNull()
    expect(saved.to).toEqual([
      DEV,
      { ...PRIYA, fills: { 'name.first': 'Priya' } },
    ])
    await open({ modal: 'email', new: 1, draft: DRAFT })
    await press('Review')
    // Nothing is flagged now, so Dev's copy opens first; Priya's holds the fill.
    act(() =>
      document
        .querySelector<HTMLElement>(`[data-review-row="${PRIYA.email}"]`)
        ?.click(),
    )
    expect(fillCell()?.value).toBe('Priya')
    expect(
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Send 2 emails')
        ?.hasAttribute('disabled'),
    ).toBe(false)
  })
})
