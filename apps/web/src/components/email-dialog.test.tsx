import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
 * The email window opened from `?modal=email&id=`: the thread as message
 * cards (earlier ones folded, the newest open, an earlier one unfolding in
 * place), each header sender → recipients with its address block, the
 * sandboxed frame, quoted history behind a chip, files as cards, a foot of
 * Done, `···` and Reply with Done dropping the two params, the foot's note
 * only when the body is shared past its default, and the reply as the last
 * card — from the window's Reply or one message's own `···`.
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
    'DOMParser',
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
  searchEntities: vi.fn(),
  fileInteractionOnEntity: vi.fn(),
  unlinkInteractionFromEntity: vi.fn(),
}))
const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  search: { modal: 'email', id: '00000000-0000-4000-8000-000000000001' },
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
  useRouter: () => ({ invalidate: router.invalidate }),
}))

const HTML: EmailDetail = {
  id: ID,
  subject: 'Acme Robotics — Q3 update',
  occurredAt: '2026-10-01T09:14:00.000Z',
  from: {
    email: 'jane@acme-robotics.example',
    name: 'Jane Founder',
    you: false,
  },
  to: [{ email: 'anish@fund.example', name: null, you: true }],
  cc: [],
  bcc: [],
  via: 'Anish',
  preview: 'Q3 closed.',
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
  gmailUrl: null,
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
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailModal recordId={recordId} />
      </QueryClientProvider>,
    ),
  )
  await settle()
}

const dialog = () => document.querySelector('[role="dialog"]')
const buttons = (label: string) =>
  [...document.querySelectorAll('button')].filter(
    (b) => b.textContent.trim() === label,
  )

/** Opens a `···` by its trigger's label and reads its items, `—` for a rule. */
async function openMenu(label: string) {
  const trigger = document.querySelector(`[aria-label="${label}"]`)
  if (trigger === null) throw new Error(`no ··· ${label}`)
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await settle()
  const menu = document.querySelector('[role="menu"]')
  if (menu === null) throw new Error('no menu')
  return [...menu.children].map((el) =>
    el.getAttribute('role') === 'separator' ? '—' : el.textContent.trim(),
  )
}

async function choose(item: string) {
  const el = [...document.querySelectorAll('[role="menuitem"]')].find(
    (m) => m.textContent.trim() === item,
  )
  if (!(el instanceof HTMLElement)) throw new Error(`no ${item}`)
  act(() => el.click())
  await settle()
}

/** The cards of the thread in order: `folded <id>` or `open <id>`. */
const cards = () =>
  [...document.querySelectorAll('[data-card]')].map(
    (c) =>
      `${c.hasAttribute('data-folded') ? 'folded' : 'open'} ${c.getAttribute('data-card') ?? ''}`,
  )

describe('the email window', () => {
  it('opens from ?modal=email&id= on the message as an open card: sender → recipients and the stamp', async () => {
    await open()
    expect(fns.getEmail).toHaveBeenCalledWith({
      data: { id: ID, recordId: null },
    })
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Acme Robotics — Q3 update')
    const line = dialog()?.querySelector(
      `[data-message="${ID}"] [data-sender-line]`,
    )
    expect(line?.textContent).toBe('Jane Founder → you')
    // The address is a tooltip on the name, never printed.
    expect(text).not.toContain('jane@acme-robotics.example')
    expect(
      line?.querySelector('[data-address="jane@acme-robotics.example"]'),
    ).not.toBeNull()
  })

  it('opens the address block on bone from the line: From, To, and the sender’s own Bcc', async () => {
    fns.getEmail.mockResolvedValue({
      ...HTML,
      cc: [{ email: 'legal@acme-robotics.example', name: null, you: false }],
      bcc: [{ email: 'priya@fund.example', name: 'Priya Nair', you: false }],
    })
    await open()
    expect(dialog()?.querySelector('[data-address-block]')).toBeNull()
    const line = dialog()?.querySelector<HTMLElement>('[data-sender-line]')
    act(() => line?.click())
    const block = dialog()?.querySelector('[data-address-block]')
    const lane = (label: string) =>
      block?.querySelector(`[data-address-lane="${label}"]`)?.textContent
    expect(lane('From')).toBe('FromJane Founder')
    expect(lane('To')).toBe('Toyou')
    // An address with no name prints as the address.
    expect(lane('Cc')).toBe('Cclegal@acme-robotics.example')
    expect(lane('Bcc')).toBe('BccPriya Nair')
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

  it('cuts a Gmail quote block out of an HTML body until the chip unfolds it', async () => {
    fns.getEmail.mockResolvedValue({
      ...HTML,
      body: {
        kind: 'html',
        srcdoc:
          '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><p>Numbers attached.</p><div class="gmail_quote"><p>On Tue, Jane wrote:</p><blockquote>Send the Q2 pack</blockquote></div></body></html>',
        remoteImages: 0,
      },
    })
    await open()
    const frame = () =>
      dialog()?.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
    expect(frame()).toContain('Numbers attached.')
    expect(frame()).not.toContain('Send the Q2 pack')
    // The cut copy keeps its head, so the policy still holds.
    expect(frame()).toContain('Content-Security-Policy')
    act(() =>
      dialog()?.querySelector<HTMLElement>('[data-quoted-chip]')?.click(),
    )
    expect(frame()).toContain('Send the Q2 pack')
  })

  it('folds quoted history to a chip that unfolds it', async () => {
    fns.getEmail.mockResolvedValue({
      ...HTML,
      body: {
        kind: 'text',
        text: 'Numbers attached.\n\nOn Tue, Jane wrote:\n> Send the Q2 pack',
      },
    })
    await open()
    const card = () => dialog()?.querySelector(`[data-message="${ID}"]`)
    expect(card()?.textContent).toContain('Numbers attached.')
    expect(card()?.textContent).not.toContain('Send the Q2 pack')
    const chip = card()?.querySelector<HTMLElement>('[data-quoted-chip]')
    act(() => chip?.click())
    expect(card()?.textContent).toContain('Send the Q2 pack')
  })

  it('lists a message’s files as cards with the type glyph and size, and opens one in the viewer over the thread', async () => {
    fns.getDocumentPreview.mockResolvedValue(null)
    await open()
    // The band is gone: the files sit under the message's rule.
    expect(dialog()?.textContent).not.toContain('Attachments ·')
    const fileCard = dialog()?.querySelector(
      `[data-files-of="${ID}"] [data-file-card="d1"]`,
    )
    if (fileCard === null || fileCard === undefined)
      throw new Error('no file card')
    expect(
      fileCard.querySelector('[data-glyph]')?.getAttribute('data-glyph'),
    ).toBe('pdf')
    expect(fileCard.querySelector('[data-file-size]')?.textContent).toBe(
      '2.0 KB',
    )
    expect(
      fileCard.querySelector('[aria-label="More for acme-q3.pdf"]'),
    ).not.toBeNull()
    act(() => fileCard.querySelector('button')?.click())
    await settle()
    expect(fns.getDocumentPreview).toHaveBeenCalledWith({ data: { id: 'd1' } })
    expect(fns.getDocumentDownloadUrl).not.toHaveBeenCalled()
  })

  it('stacks the viewer as a second window that steps through the message’s files and ends on Done', async () => {
    const second = {
      ...HTML.attachments[0],
      documentId: 'd2',
      name: 'cap-table.xlsx',
      filename: 'cap-table.xlsx',
      mime: null,
    }
    fns.getEmail.mockResolvedValue({
      ...HTML,
      attachments: [HTML.attachments[0], second],
    })
    const doc = (id: string, filename: string) => ({
      id,
      filename,
      mime: 'text/plain',
      sizeBytes: 10,
      extractionStatus: 'done',
      extractionError: null,
      blobSha: null,
      url: null,
    })
    fns.getDocumentPreview.mockImplementation(
      ({ data }: { data: { id: string } }) =>
        Promise.resolve(
          data.id === 'd1'
            ? doc('d1', 'acme-q3.pdf')
            : doc('d2', 'cap-table.xlsx'),
        ),
    )
    fns.getDocumentText.mockResolvedValue({ text: 'rows' })
    await open()
    act(() =>
      document
        .querySelector<HTMLElement>('[data-file-card="d1"] button')
        ?.click(),
    )
    await settle()
    const viewer = document.querySelector('[data-window-depth="2"]')
    expect(viewer).not.toBeNull()
    const stepper = viewer?.querySelector('[data-file-stepper]')
    expect(stepper?.textContent).toBe('‹File 1 of 2›')
    const foot = viewer?.querySelector('[data-slot="dialog-footer"]')
    expect(
      [...(foot?.querySelectorAll('button') ?? [])].map((b) =>
        b.textContent.trim(),
      ),
    ).toEqual(['Ask about this', '‹', '›', 'Done'])
    act(() =>
      stepper?.querySelector<HTMLElement>('[aria-label="Next file"]')?.click(),
    )
    await settle()
    expect(fns.getDocumentPreview).toHaveBeenLastCalledWith({
      data: { id: 'd2' },
    })
    expect(
      document.querySelector('[data-window-depth="2"] [data-file-stepper]')
        ?.textContent,
    ).toBe('‹File 2 of 2›')
  })

  it('says a private body in one line and lists no file', async () => {
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

  it('prints nothing for a message with no body', async () => {
    fns.getEmail.mockResolvedValue({ ...HTML, body: { kind: 'none' } })
    await open()
    expect(dialog()?.textContent).toContain('Acme Robotics — Q3 update')
    expect(dialog()?.textContent).not.toContain('No body')
    expect(dialog()?.querySelector('iframe')).toBeNull()
  })

  it('leads its head on the 20px email glyph', async () => {
    await open()
    const mark = dialog()?.querySelector(
      '[data-slot="dialog-header"] [data-window-mark]',
    )
    expect(mark?.getAttribute('class')).toContain('size-5')
  })

  it('ends on Done, the ··· and Reply, and Done drops the modal params', async () => {
    await open()
    const foot = dialog()?.querySelector('[data-slot="dialog-footer"]')
    expect(
      [...(foot?.querySelectorAll('button') ?? [])].map(
        (b) => b.getAttribute('aria-label') ?? b.textContent.trim(),
      ),
    ).toEqual(['Done', 'More for Acme Robotics — Q3 update', 'Reply'])
    expect(buttons('Cancel')).toHaveLength(0)
    const cancel = buttons('Done')[0]
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

describe('who reads it', () => {
  const footNote = () =>
    dialog()?.querySelector('[data-slot="dialog-footer"] > span.mono')
      ?.textContent ?? null
  const windowMenu = () => openMenu('More for Acme Robotics — Q3 update')

  it('says nothing at the foot for a shared (forwarded) body, its label chip kept', async () => {
    fns.getEmail.mockResolvedValue({ ...HTML, categories: ['pitch'] })
    await open()
    expect(footNote()).toBeNull()
    expect(
      dialog()?.querySelector('[data-category="pitch"]')?.textContent,
    ).toBe('Pitch')
    expect(await windowMenu()).toEqual(['Copy link', 'File on a deal…'])
  })

  it('says nothing at the foot for the owner’s own private mail', async () => {
    fns.getEmail.mockResolvedValue(OWN)
    await open(RECORD)
    expect(fns.getEmail).toHaveBeenCalledWith({
      data: { id: ID, recordId: RECORD },
    })
    expect(footNote()).toBeNull()
  })

  it('says nothing for someone else’s private body, and offers no widen', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      body: { kind: 'private' },
      attachments: [],
      privacy: { ...MINE, mine: false, record: null },
    })
    await open(RECORD)
    expect(footNote()).toBeNull()
    expect(await windowMenu()).not.toContain('Who can read this…')
    expect(dialog()?.querySelector('[data-body-private]')?.textContent).toBe(
      'Private to Anish’s mailbox',
    )
  })

  it('says who it is shared with once the owner opens it up, and by whom to the reader it reaches', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: {
        ...MINE,
        grantees: [{ id: 'u-maya', name: 'Maya', you: false }],
      },
    })
    await open(RECORD)
    expect(footNote()).toBe('Shared with Maya')

    act(() => root.unmount())
    root = createRoot(host)
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: { ...MINE, workspace: true },
    })
    await open(RECORD)
    expect(footNote()).toBe('Shared with the workspace')

    act(() => root.unmount())
    root = createRoot(host)
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: { ...MINE, mine: false, workspace: true, record: null },
    })
    await open(RECORD)
    expect(footNote()).toBe('Shared by Anish')
  })

  it('holds Open in Gmail, Copy link, File on a deal…, Who can read this…, then Unlink', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      gmailUrl: 'https://mail.google.com/mail/#search/rfc822msgid%3Aq3%40acme',
      record: { id: RECORD, name: 'Flent', linked: true },
    })
    await open(RECORD)
    expect(await windowMenu()).toEqual([
      'Open in Gmail',
      'Copy link',
      'File on a deal…',
      'Who can read this…',
      '—',
      'Unlink from Flent…',
    ])
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
    await windowMenu()
    await choose('Who can read this…')
    const widen = [...document.querySelectorAll('[role="dialog"]')].find(
      (d) =>
        d.querySelector('[data-slot="dialog-title"]')?.textContent ===
        'Who can read this',
    )
    if (widen === undefined) throw new Error('no widen window')
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
  const JANE = {
    email: 'jane@acme-robotics.example',
    name: 'Jane Founder',
    you: false,
  }
  const ME = { email: 'anish@fund.example', name: 'Anish', you: true }
  const line = (
    id: string,
    over: Partial<EmailThreadLine> = {},
  ): EmailThreadLine => ({
    id,
    from: JANE,
    to: [ME],
    cc: [],
    preview: 'Q2 numbers attached',
    attachments: 0,
    occurredAt: '2026-09-02T18:40:00.000Z',
    ...over,
  })
  const B1 = '00000000-0000-4000-8000-0000000000b1'
  const B2 = '00000000-0000-4000-8000-0000000000b2'
  const B3 = '00000000-0000-4000-8000-0000000000b3'
  const THREADED: EmailDetail = {
    ...HTML,
    thread: {
      messages: 4,
      earlier: [
        line(B1),
        line(B2, { from: ME, to: [JANE], preview: null }),
        line(B3, { attachments: 2 }),
      ],
    },
  }
  /** Each message as `getEmail` reads it: the newest is the window's own. */
  const byId = (id: string): EmailDetail =>
    id === B2
      ? {
          ...HTML,
          id: B2,
          from: ME,
          to: [JANE],
          body: { kind: 'text', text: 'Sending the Q2 pack.' },
          attachments: [],
        }
      : id === B3
        ? {
            ...HTML,
            id: B3,
            body: { kind: 'text', text: 'Q2 numbers attached.' },
            attachments: [
              {
                ...HTML.attachments[0],
                documentId: 'd-q2',
                name: 'acme-q2.pdf',
                filename: 'acme-q2.pdf',
              },
            ],
          }
        : THREADED

  const card = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-card="${id}"]`)
    if (el === null) throw new Error(`no card ${id}`)
    return el
  }

  it('heads with the count, folds every earlier message oldest first and opens the newest last', async () => {
    fns.getEmail.mockResolvedValue(THREADED)
    await open()
    expect(
      dialog()?.querySelector('[data-slot="dialog-description"]')?.textContent,
    ).toBe('4 messages')
    expect(cards()).toEqual([
      `folded ${B1}`,
      `folded ${B2}`,
      `folded ${B3}`,
      `open ${ID}`,
    ])
    expect(dialog()?.querySelector('iframe')).not.toBeNull()
  })

  it('writes every folded line one way: sender → recipients, yours as You', async () => {
    fns.getEmail.mockResolvedValue(THREADED)
    await open()
    const lineOf = (id: string) =>
      card(id).querySelector('[data-sender-line]')?.textContent
    expect(lineOf(B1)).toBe('Jane Founder → you')
    expect(lineOf(B2)).toBe('You → Jane Founder')
    expect(card(B3).querySelector('[aria-label="Attachments"]')).not.toBeNull()
  })

  it('unfolds an earlier message in place, with its own files, and keeps the open one', async () => {
    fns.getEmail.mockImplementation(({ data }: { data: { id: string } }) =>
      Promise.resolve(byId(data.id)),
    )
    await open()
    act(() => card(B3).click())
    await settle()
    expect(fns.getEmail).toHaveBeenLastCalledWith({
      data: { id: B3, recordId: null },
    })
    expect(cards()).toEqual([
      `folded ${B1}`,
      `folded ${B2}`,
      `open ${B3}`,
      `open ${ID}`,
    ])
    const unfolded = card(B3)
    expect(unfolded.textContent).toContain('Q2 numbers attached.')
    // Its files sit under it, the open message keeps its own.
    expect(
      unfolded.querySelector(`[data-files-of="${B3}"]`)?.textContent,
    ).toContain('acme-q2.pdf')
    expect(
      document.querySelector(`[data-files-of="${ID}"]`)?.textContent,
    ).toContain('acme-q3.pdf')
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

  it('grows the draft as the last card, in ink, under the message folded', async () => {
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
    expect(cards()).toEqual([`folded ${ID}`])
    const draft = dialog()?.querySelector('[data-draft-card]')
    expect(draft?.getAttribute('class')).toContain('border-hairline')
    // The draft follows the message it answers.
    const folded = dialog()?.querySelector(`[data-card="${ID}"]`)
    expect(
      folded !== null &&
        folded !== undefined &&
        draft !== null &&
        draft !== undefined &&
        folded.compareDocumentPosition(draft) &
          Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(dialog()?.querySelector('iframe')).toBeNull()
    expect(
      draft?.querySelector('[data-chip="jane@acme-robotics.example"]'),
    ).not.toBeNull()
    const modes = [...document.querySelectorAll('[role="radio"]')].map(
      (t) => t.textContent,
    )
    expect(modes).toEqual(['Reply', 'Reply all', 'Forward'])
    expect(draft?.querySelector('[data-tool-row]')?.textContent).toContain(
      'Attach',
    )
    // The composer's own foot: Cancel and Send.
    expect(buttons('Cancel')).toHaveLength(1)
    expect(buttons('Send')).toHaveLength(1)
  })

  it('forwards an earlier message from its own ···, the earlier cards kept', async () => {
    const B1 = '00000000-0000-4000-8000-0000000000b1'
    const earlier: EmailDetail = {
      ...HTML,
      id: B1,
      body: { kind: 'text', text: 'The Q2 pack.' },
      attachments: [],
    }
    fns.getEmail.mockImplementation(({ data }: { data: { id: string } }) =>
      Promise.resolve(
        data.id === B1
          ? earlier
          : {
              ...HTML,
              thread: {
                messages: 2,
                earlier: [
                  {
                    id: B1,
                    from: HTML.from,
                    to: HTML.to,
                    cc: [],
                    preview: 'The Q2 pack.',
                    attachments: 0,
                    occurredAt: '2026-09-02T18:40:00.000Z',
                  },
                ],
              },
            },
      ),
    )
    fns.openEmailReply.mockResolvedValue(OPENING)
    await open()
    act(() =>
      document.querySelector<HTMLElement>(`[data-card="${B1}"]`)?.click(),
    )
    await settle()
    expect(await openMenu('More for message from Jane Founder')).toEqual([
      'Reply',
      'Reply all',
      'Forward',
    ])
    await choose('Forward')
    expect(fns.openEmailReply).toHaveBeenCalledWith({ data: { parentId: B1 } })
    expect(body()).toBe('---------- Forwarded message ----------')
    expect(
      [...document.querySelectorAll('[role="radio"]')].find(
        (t) => t.getAttribute('aria-checked') === 'true',
      )?.textContent,
    ).toBe('Forward')
    expect(cards()).toEqual([`folded ${B1}`, `folded ${ID}`])
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
