import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DraftFields,
  EmailDetail,
  EmailPrivacy,
  EmailThreadLine,
  ReplyOpening,
} from '#/lib/server-fns'
import { EmailModal } from './email-dialog'

/**
 * The email window opened from `?modal=email&id=`: the
 * sandboxed frame, the remote-image count printed once, a private body as
 * a bone panel, one close in the foot that drops the two params, the
 * privacy line with its widen window, and the thread's earlier messages.
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

const ID = '00000000-0000-4000-8000-000000000001'

const fns = vi.hoisted(() => ({
  getEmail: vi.fn(),
  getDocumentPreview: vi.fn(),
  getDocumentDownloadUrl: vi.fn(),
  getDocumentText: vi.fn(),
  listMembers: vi.fn(),
  setEmailAudience: vi.fn(),
  openEmailReply: vi.fn(),
  saveEmailDraft: vi.fn(),
  deleteEmailDraft: vi.fn(),
  searchEmailRecipients: vi.fn(),
  getEmailSender: vi.fn(),
  fileDocument: vi.fn(),
  listRecordDocuments: vi.fn(),
  listEmailVariables: vi.fn(),
}))
const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: { modal: 'email', id: '00000000-0000-4000-8000-000000000001' },
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
}))

const HTML: EmailDetail = {
  id: ID,
  subject: 'Acme Robotics — Q3 update',
  occurredAt: '2026-10-01T09:14:00.000Z',
  from: { email: 'jane@acme-robotics.example', name: 'Jane Founder' },
  to: [{ email: 'anish@fund.example', name: null }],
  cc: [],
  bcc: [],
  via: 'Anish',
  body: {
    kind: 'html',
    srcdoc: '<!doctype html><html><body><p>Q3 closed.</p></body></html>',
    remoteImages: 2,
  },
  attachments: [
    {
      documentId: 'd1',
      name: 'acme-q3.pdf',
      filename: 'acme-q3.pdf',
      mime: 'application/pdf',
      sizeBytes: 2048,
      lane: 'gmail',
      uploader: 'Anish',
      addedAt: '2026-10-01T09:20:00.000Z',
    },
  ],
  privacy: null,
  categories: [],
  thread: { messages: 1, earlier: [] },
  record: null,
}

const RECORD = '00000000-0000-4000-8000-0000000000aa'

const MINE: EmailPrivacy = {
  owner: { id: 'u-anish', name: 'Anish' },
  mine: true,
  workspace: false,
  grantees: [],
  record: { id: RECORD, name: 'Flent', on: false },
}

/** The owner's own synced email, opened from Flent, widened to nobody. */
const OWN: EmailDetail = { ...HTML, privacy: MINE }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset()
  router.navigate.mockReset()
  fns.getEmail.mockResolvedValue(HTML)
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

async function open(recordId: string | null = null) {
  act(() => root.render(<EmailModal recordId={recordId} />))
  await settle()
}

const dialog = () => document.querySelector('[role="dialog"]')
const buttons = (label: string) =>
  [...document.querySelectorAll('button')].filter(
    (b) => b.textContent.trim() === label,
  )

describe('the email window', () => {
  it('opens from ?modal=email&id= with the subject, the date and the participants', async () => {
    await open()
    expect(fns.getEmail).toHaveBeenCalledWith({
      data: { id: ID, recordId: null },
    })
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Acme Robotics — Q3 update')
    expect(text).toContain('Jane Founder')
    expect(text).toContain('anish@fund.example')
    expect(text).toContain('acme-q3.pdf')
  })

  it('shows the sender their Bcc, each chip read as hidden', async () => {
    fns.getEmail.mockResolvedValue({
      ...HTML,
      bcc: [{ email: 'priya@fund.example', name: 'Priya Nair' }],
    })
    await open()
    const chip = dialog()?.querySelector('[data-bcc="priya@fund.example"]')
    expect(chip?.textContent).toContain('Priya Nair')
    expect(chip?.textContent).toContain('hidden')
  })

  it('renders the body in a frame sandboxed with no scripts and no forms', async () => {
    await open()
    const frame = dialog()?.querySelector('iframe')
    const sandbox = frame?.getAttribute('sandbox') ?? ''
    expect(frame).not.toBeNull()
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-forms')
    expect(sandbox).toContain('allow-popups')
    expect(frame?.getAttribute('srcdoc')).toContain('Q3 closed.')
  })

  it('counts the remote images in one line', async () => {
    await open()
    const lines = dialog()?.querySelectorAll('[data-remote-images]') ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]?.textContent).toBe('2 remote images not loaded')
  })

  it('lists an attachment with its type glyph, size and lane, and opens it in the preview, not a download', async () => {
    fns.getDocumentPreview.mockResolvedValue(null)
    await open()
    const row = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('acme-q3.pdf'),
    )
    if (row === undefined) throw new Error('no attachment row')
    expect(row.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe(
      'pdf',
    )
    expect(row.querySelector('[data-attachment-lane]')?.textContent).toMatch(
      /^2\.0 KB · Anish · 1 Oct( 2026)?$/,
    )
    act(() => row.click())
    await settle()
    expect(fns.getDocumentPreview).toHaveBeenCalledWith({ data: { id: 'd1' } })
    expect(fns.getDocumentDownloadUrl).not.toHaveBeenCalled()
  })

  it('says a private body in one line and lists no attachment', async () => {
    fns.getEmail.mockResolvedValue({
      ...HTML,
      body: { kind: 'private' },
      attachments: [],
    })
    await open()
    expect(dialog()?.querySelector('iframe')).toBeNull()
    expect(dialog()?.querySelector('[data-body-private]')).not.toBeNull()
    expect(dialog()?.textContent).not.toContain('acme-q3.pdf')
  })

  it('has one close, in the foot, which drops the modal params', async () => {
    await open()
    expect(buttons('Cancel')).toHaveLength(1)
    const cancel = buttons('Cancel')[0]
    expect(cancel.closest('[data-slot="dialog-footer"]')).not.toBeNull()
    expect(dialog()?.textContent ?? '').not.toMatch(/\besc\b/i)
    act(() => cancel.click())
    expect(router.navigate).toHaveBeenCalledTimes(1)
    const call: unknown = router.navigate.mock.calls[0]?.[0]
    if (typeof call !== 'object' || call === null || !('search' in call))
      throw new Error('no search')
    const search = call.search
    if (typeof search !== 'function') throw new Error('not a function')
    expect(search({ tab: 'interactions', modal: 'email', id: ID })).toEqual({
      tab: 'interactions',
      modal: undefined,
      id: undefined,
    })
  })
})

describe('the privacy row', () => {
  const privacyRow = () =>
    dialog()?.querySelector('[data-privacy]')?.textContent ?? null

  it('reads the workspace with no control on a shared (forwarded) body, beside its label chip', async () => {
    fns.getEmail.mockResolvedValue({ ...HTML, categories: ['pitch'] })
    await open()
    expect(privacyRow()).toBe('Visible to the workspace')
    expect(buttons('Widen…')).toHaveLength(0)
    expect(
      dialog()?.querySelector('[data-category="pitch"]')?.textContent,
    ).toBe('Pitch')
  })

  it('reads "Visible to you  Widen…" to the owner', async () => {
    fns.getEmail.mockResolvedValue(OWN)
    await open(RECORD)
    expect(fns.getEmail).toHaveBeenCalledWith({
      data: { id: ID, recordId: RECORD },
    })
    expect(privacyRow()).toBe('Visible to you  Widen…')
  })

  it('names the owner and offers no widen to anyone else', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      body: { kind: 'private' },
      attachments: [],
      privacy: {
        owner: { id: 'u-anish', name: 'Anish' },
        mine: false,
        workspace: false,
        grantees: [],
        record: null,
      },
    })
    await open(RECORD)
    expect(privacyRow()).toBe('Visible to Anish')
    expect(buttons('Widen…')).toHaveLength(0)
    // Private: the From lane appears, and the body is a bone panel.
    expect(dialog()?.textContent).toContain('From')
    expect(dialog()?.querySelector('[data-body-private]')?.textContent).toBe(
      'Private to Anish’s mailbox',
    )
  })

  it('reads the grantees, and the workspace once an override covers it', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: {
        ...MINE,
        grantees: [{ id: 'u-maya', name: 'Maya', you: false }],
      },
    })
    await open(RECORD)
    expect(privacyRow()).toBe('Visible to you, Maya  Widen…')
    act(() => root.unmount())
    root = createRoot(host)
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: { ...MINE, workspace: true },
    })
    await open(RECORD)
    expect(privacyRow()).toBe(
      'Visible to the workspace · all your email with Flent  Change…',
    )
  })

  it('widens in "Who can read this": the owner, the grantees with ×, every email with the record', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: {
        ...MINE,
        grantees: [{ id: 'u-maya', name: 'Maya', you: false }],
      },
    })
    fns.listMembers.mockResolvedValue([
      { id: 'u-anish', name: 'Anish', banned: false },
      { id: 'u-maya', name: 'Maya', banned: false },
      { id: 'u-gone', name: 'Gone', banned: true },
    ])
    fns.setEmailAudience.mockResolvedValue({ ok: true })
    await open(RECORD)
    act(() => buttons('Widen…')[0]?.click())
    await settle()
    const widen = [...document.querySelectorAll('[role="dialog"]')].at(-1)
    if (widen === undefined) throw new Error('no widen window')
    expect(widen.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(
      'Who can read this',
    )
    const text = widen.textContent
    expect(text).toContain('AnishOwner')
    expect(text).toContain('Maya')
    expect(text).toContain('Every email I have with Flent')
    const foot = widen.querySelector('[data-slot="dialog-footer"]')
    expect(foot?.textContent).toBe(
      'Subject, people and date stay visible to allCancelWiden',
    )
    const remove = widen.querySelector('[aria-label="Remove Maya"]')
    if (!(remove instanceof HTMLElement)) throw new Error('no ×')
    act(() => remove.click())
    const box = widen.querySelector(
      '[role="checkbox"][aria-label="Every email I have with Flent"]',
    )
    if (!(box instanceof HTMLElement)) throw new Error('no box')
    act(() => box.click())
    const save = [...widen.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Widen',
    )
    act(() => save?.click())
    await settle()
    expect(fns.setEmailAudience).toHaveBeenCalledWith({
      data: {
        interactionId: ID,
        userIds: [],
        record: { id: RECORD, workspace: true },
      },
    })
    // Saved, the window reads the email again.
    expect(fns.getEmail).toHaveBeenCalledTimes(2)
  })
})

describe('the thread', () => {
  const line = (
    id: string,
    over: Partial<EmailThreadLine> = {},
  ): EmailThreadLine => ({
    id,
    who: 'Jane Founder',
    sent: false,
    preview: 'Q2 numbers attached',
    attachments: 0,
    occurredAt: '2026-09-02T18:40:00.000Z',
    ...over,
  })
  const THREADED: EmailDetail = {
    ...HTML,
    thread: {
      messages: 4,
      earlier: [
        line('00000000-0000-4000-8000-0000000000b1'),
        line('00000000-0000-4000-8000-0000000000b2', {
          who: 'Jane Founder',
          sent: true,
          preview: null,
        }),
        line('00000000-0000-4000-8000-0000000000b3', { attachments: 2 }),
      ],
    },
  }

  it('heads with the count and folds the oldest past two, a sent line reading To <name>', async () => {
    fns.getEmail.mockResolvedValue(THREADED)
    await open()
    expect(
      dialog()?.querySelector('[data-slot="dialog-description"]')?.textContent,
    ).toBe('4 messages')
    expect(dialog()?.querySelector('[data-folded-earlier]')?.textContent).toBe(
      '1 earlier message',
    )
    const shown = [...document.querySelectorAll('[data-thread-line]')]
    expect(shown.map((l) => l.getAttribute('data-thread-line'))).toEqual([
      '00000000-0000-4000-8000-0000000000b2',
      '00000000-0000-4000-8000-0000000000b3',
    ])
    expect(shown[0]?.textContent).toContain('To Jane Founder')
    expect(shown[1]?.querySelector('[aria-label="Attachments"]')).not.toBeNull()
    act(() =>
      document.querySelector<HTMLElement>('[data-folded-earlier]')?.click(),
    )
    expect(document.querySelectorAll('[data-thread-line]')).toHaveLength(3)
  })

  it('opens an earlier message in the same window', async () => {
    fns.getEmail.mockResolvedValue(THREADED)
    await open()
    act(() =>
      document
        .querySelector<HTMLElement>(
          '[data-thread-line="00000000-0000-4000-8000-0000000000b3"]',
        )
        ?.click(),
    )
    await settle()
    expect(fns.getEmail).toHaveBeenLastCalledWith({
      data: { id: '00000000-0000-4000-8000-0000000000b3', recordId: null },
    })
  })
})

describe('a reply (E3)', () => {
  beforeEach(() => {
    fns.saveEmailDraft.mockResolvedValue({
      id: 'saved',
      updatedAt: '2026-10-19T09:16:00.000Z',
    })
  })
  const start = (over: Partial<DraftFields>): DraftFields => ({
    mode: 'reply',
    inReplyToId: ID,
    to: [],
    cc: [],
    bcc: [],
    subject: 'Re: Acme Robotics — Q3 update',
    bodyMd: '',
    attachments: [],
    ...over,
  })
  const OPENING: ReplyOpening = {
    draft: null,
    modes: {
      reply: start({
        to: [
          {
            email: 'jane@acme-robotics.example',
            entityId: '00000000-0000-4000-8000-0000000000f1',
            name: 'Jane Founder',
          },
        ],
      }),
      reply_all: start({
        mode: 'reply_all',
        to: [{ email: 'jane@acme-robotics.example', name: 'Jane Founder' }],
        cc: [{ email: 'cfo@acme-robotics.example' }],
      }),
      forward: start({
        mode: 'forward',
        subject: 'Fwd: Acme Robotics — Q3 update',
        bodyMd: '---------- Forwarded message ----------',
        attachments: [
          {
            documentId: 'd1',
            name: 'acme-q3.pdf',
            mime: 'application/pdf',
            sizeBytes: 2048,
          },
        ],
      }),
    },
  }

  const typeBody = (value: string) => {
    const el = document.querySelector('textarea[aria-label="Message"]')
    if (!(el instanceof HTMLTextAreaElement)) throw new Error('no body')
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(el, value)
    act(() => {
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const body = () =>
    document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    )?.value

  it('grows under the folded message with the sender prefilled', async () => {
    fns.getEmail.mockResolvedValue({
      ...HTML,
      body: { kind: 'text', text: 'Q3 closed ahead of plan.' },
    })
    fns.openEmailReply.mockResolvedValue(OPENING)
    await open(RECORD)
    act(() => buttons('Reply')[0]?.click())
    await settle()
    expect(fns.openEmailReply).toHaveBeenCalledWith({
      data: { parentId: ID },
    })
    const folded = dialog()?.querySelector('[data-folded-message]')
    expect(folded?.textContent).toMatch(/^Jane Founderwrote (at|on) .+·Show$/)
    expect(dialog()?.querySelector('iframe')).toBeNull()
    expect(
      dialog()?.querySelector('[data-chip="jane@acme-robotics.example"]'),
    ).not.toBeNull()
    const modes = [...document.querySelectorAll('[role="radio"]')].map(
      (t) => t.textContent,
    )
    expect(modes).toEqual(['Reply', 'Reply all', 'Forward'])
    // Still one close.
    expect(buttons('Cancel')).toHaveLength(1)
  })

  it('switching to Forward keeps what was written and brings the files', async () => {
    fns.openEmailReply.mockResolvedValue(OPENING)
    await open()
    act(() => buttons('Reply')[0]?.click())
    await settle()
    typeBody('Priya — can you check the ESOP math?')
    const forward = [...document.querySelectorAll('[role="radio"]')].find(
      (t) => t.textContent === 'Forward',
    )
    if (!(forward instanceof HTMLElement)) throw new Error('no mode')
    act(() => forward.click())
    expect(body()).toBe(
      'Priya — can you check the ESOP math?\n\n---------- Forwarded message ----------',
    )
    expect(
      dialog()?.querySelector('[data-chip="jane@acme-robotics.example"]'),
    ).toBeNull()
    const file = dialog()?.querySelector('[data-attachment="d1"]')
    expect(file?.textContent).toContain('2.0 KB')
    expect(file?.querySelector('[data-from-original]')?.textContent).toBe(
      'From original',
    )
  })

  it('reopens the draft held on the email', async () => {
    fns.openEmailReply.mockResolvedValue({
      ...OPENING,
      draft: {
        ...OPENING.modes.reply,
        id: '00000000-0000-4000-8000-0000000000d9',
        bodyMd: 'Thanks Jane',
        updatedAt: '2026-10-19T09:16:00.000Z',
      },
    })
    await open()
    act(() => buttons('Reply')[0]?.click())
    await settle()
    expect(body()).toBe('Thanks Jane')
    expect(dialog()?.querySelector('[data-saved]')?.textContent).toMatch(
      /^Saved \d\d:\d\d$/,
    )
  })
})
