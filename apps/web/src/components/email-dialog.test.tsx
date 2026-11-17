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
 * The email window opened from `?modal=email&id=`: the
 * sandboxed frame, the remote-image count printed once, a private body as
 * a bone panel, a foot of Done, `···` and Reply with Done dropping the two
 * params, who reads a private body at the foot's left with its widen
 * window in the `···`, and the thread's earlier messages unfolding in place.
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

  async function openMore() {
    const trigger = document.querySelector(
      '[aria-label="More for Acme Robotics — Q3 update"]',
    )
    if (trigger === null) throw new Error('no ···')
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

  it('says nothing at the foot for a shared (forwarded) body, its label chip kept', async () => {
    fns.getEmail.mockResolvedValue({ ...HTML, categories: ['pitch'] })
    await open()
    expect(footNote()).toBeNull()
    expect(
      dialog()?.querySelector('[data-category="pitch"]')?.textContent,
    ).toBe('Pitch')
    expect(await openMore()).toEqual([
      'Forward',
      'Copy link',
      'File on a deal…',
    ])
  })

  it('reads Visible to you at the foot while the owner’s body is private', async () => {
    fns.getEmail.mockResolvedValue(OWN)
    await open(RECORD)
    expect(fns.getEmail).toHaveBeenCalledWith({
      data: { id: ID, recordId: RECORD },
    })
    expect(footNote()).toBe('Visible to you')
    expect(dialog()?.querySelector('[data-privacy]')).toBeNull()
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
    expect(footNote()).toBe('Visible to Anish')
    expect(await openMore()).not.toContain('Who can read this…')
    // Private: the From lane appears, and the body is a bone panel.
    expect(dialog()?.textContent).toContain('From')
    expect(dialog()?.querySelector('[data-body-private]')?.textContent).toBe(
      'Private to Anish’s mailbox',
    )
  })

  it('reads the grantees, and nothing once an override opens it to the workspace', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: {
        ...MINE,
        grantees: [{ id: 'u-maya', name: 'Maya', you: false }],
      },
    })
    await open(RECORD)
    expect(footNote()).toBe('Visible to you, Maya')
    act(() => root.unmount())
    root = createRoot(host)
    fns.getEmail.mockResolvedValue({
      ...OWN,
      privacy: { ...MINE, workspace: true },
    })
    await open(RECORD)
    expect(footNote()).toBeNull()
  })

  it('holds Forward, Open in Gmail, Copy link, File on a deal…, Who can read this…, then Unlink', async () => {
    fns.getEmail.mockResolvedValue({
      ...OWN,
      gmailUrl: 'https://mail.google.com/mail/#search/rfc822msgid%3Aq3%40acme',
      record: { id: RECORD, name: 'Flent', linked: true },
    })
    await open(RECORD)
    expect(await openMore()).toEqual([
      'Forward',
      'Open in Gmail',
      'Copy link',
      'File on a deal…',
      'Who can read this…',
      '—',
      'Unlink from Flent…',
    ])
  })

  it('forwards from the ···: the draft opens in its forward mode', async () => {
    fns.openEmailReply.mockResolvedValue({
      draft: null,
      modes: {
        reply: {
          mode: 'reply',
          inReplyToId: ID,
          to: [],
          cc: [],
          bcc: [],
          subject: 'Re: Acme',
          bodyMd: '',
          attachments: [],
        },
        reply_all: {
          mode: 'reply_all',
          inReplyToId: ID,
          to: [],
          cc: [],
          bcc: [],
          subject: 'Re: Acme',
          bodyMd: '',
          attachments: [],
        },
        forward: {
          mode: 'forward',
          inReplyToId: ID,
          to: [],
          cc: [],
          bcc: [],
          subject: 'Fwd: Acme',
          bodyMd: '---------- Forwarded message ----------',
          attachments: [],
        },
      },
    })
    await open()
    await openMore()
    const forward = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent.trim() === 'Forward',
    )
    if (!(forward instanceof HTMLElement)) throw new Error('no Forward')
    act(() => forward.click())
    await settle()
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      )?.value,
    ).toBe('---------- Forwarded message ----------')
    expect(
      [...document.querySelectorAll('[role="radio"]')].find(
        (t) => t.getAttribute('aria-checked') === 'true',
      )?.textContent,
    ).toBe('Forward')
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
    await openMore()
    const who = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent.trim() === 'Who can read this…',
    )
    if (!(who instanceof HTMLElement)) throw new Error('no Who can read this…')
    act(() => who.click())
    await settle()
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
  const B1 = '00000000-0000-4000-8000-0000000000b1'
  const B2 = '00000000-0000-4000-8000-0000000000b2'
  const B3 = '00000000-0000-4000-8000-0000000000b3'
  const THREADED: EmailDetail = {
    ...HTML,
    thread: {
      messages: 4,
      earlier: [
        line(B1),
        line(B2, { who: 'Jane Founder', sent: true, preview: null }),
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

  const lineButton = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-thread-line="${id}"]`)
    if (el === null) throw new Error(`no line ${id}`)
    return el
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
      B2,
      B3,
    ])
    expect(shown[0]?.textContent).toContain('To Jane Founder')
    expect(shown[1]?.querySelector('[aria-label="Attachments"]')).not.toBeNull()
    act(() =>
      document.querySelector<HTMLElement>('[data-folded-earlier]')?.click(),
    )
    expect(document.querySelectorAll('[data-thread-line]')).toHaveLength(3)
  })

  it('opens the newest message, and every earlier one folded to its line', async () => {
    fns.getEmail.mockResolvedValue(THREADED)
    await open()
    expect(document.querySelector(`[data-message="${ID}"]`)).not.toBeNull()
    expect(dialog()?.querySelector('iframe')).not.toBeNull()
    expect(document.querySelector(`[data-message="${B3}"]`)).toBeNull()
    expect(lineButton(B3).getAttribute('aria-expanded')).toBe('false')
  })

  it('unfolds an earlier message in place, with its own files, and keeps the open one', async () => {
    fns.getEmail.mockImplementation(({ data }: { data: { id: string } }) =>
      Promise.resolve(byId(data.id)),
    )
    await open()
    act(() => lineButton(B3).click())
    await settle()
    expect(fns.getEmail).toHaveBeenLastCalledWith({
      data: { id: B3, recordId: null },
    })
    const unfolded = document.querySelector(`[data-message="${B3}"]`)
    expect(unfolded?.textContent).toContain('Jane Founder')
    expect(unfolded?.textContent).toContain('Q2 numbers attached.')
    // Its files sit under it, the open message keeps its own.
    expect(
      unfolded?.querySelector(`[data-files-of="${B3}"]`)?.textContent,
    ).toContain('acme-q2.pdf')
    expect(
      document.querySelector(`[data-files-of="${ID}"]`)?.textContent,
    ).toContain('acme-q3.pdf')
    expect(document.querySelector(`[data-message="${ID}"]`)).not.toBeNull()
    expect(lineButton(B3).getAttribute('aria-expanded')).toBe('true')

    // A second one opens beside it; a click on an open line folds it.
    act(() => lineButton(B2).click())
    await settle()
    expect(document.querySelector(`[data-message="${B2}"]`)).not.toBeNull()
    expect(document.querySelector(`[data-message="${B3}"]`)).not.toBeNull()
    act(() => lineButton(B3).click())
    expect(document.querySelector(`[data-message="${B3}"]`)).toBeNull()
    expect(document.querySelector(`[data-message="${B2}"]`)).not.toBeNull()
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
    // The composer's own foot: its Cancel is the one close.
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
