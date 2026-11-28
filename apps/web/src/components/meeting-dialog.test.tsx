import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MeetingDetail,
  MeetingRemoval,
  MeetingSheetData,
  PrepEvent,
} from '#/lib/server-fns'
import { readDock } from '#/lib/ask/dock-store'
import { MeetingDialog } from './meeting-dialog'
import { applyPrepEvent } from './meetings/meeting-sheet'

/**
 * The meeting window: replies shown and never editable, Google Calendar the
 * way to change one; artifacts by role; one close in the head and no `esc`
 * or `↵` printed; the brief run on demand from its card, never kept,
 * "Save as note" sending the brief that was shown and "Ask about this"
 * opening it in Ask; a refusal said in place.
 * - A happy-dom window's DOM globals are installed by hand before React
 *   loads.
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
const NOTE = '00000000-0000-4000-8000-0000000000ee'

const fns = vi.hoisted(() => ({
  getMeetingSheet: vi.fn(),
  prepMeeting: vi.fn(),
  savePrepAsNote: vi.fn(),
  askAboutBrief: vi.fn(),
  previewAskRef: vi.fn(),
  acceptSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  pinMeetingRecord: vi.fn(),
  searchEntities: vi.fn(),
  writeUpInteraction: vi.fn(),
  setNothingToNote: vi.fn(),
  findActionItems: vi.fn(),
  getDocumentDownloadUrl: vi.fn(),
  getDocumentText: vi.fn(),
}))
const navigate = vi.hoisted(() => vi.fn())

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({
    invalidate: () => Promise.resolve(),
    navigate,
    state: { location: { state: { __TSR_index: 1 } } },
  }),
  useNavigate: () => navigate,
  useRouterState: () => 0,
  Link: ({
    to,
    children,
    className,
  }: {
    to: string
    children: ReactNode
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

const HOUR = 3_600_000
/** An instant `hours` from now: a brief is only for a meeting still ahead. */
const fromNow = (hours: number) =>
  new Date(Date.now() + hours * HOUR).toISOString()

const DETAIL: MeetingDetail = {
  id: ID,
  title: 'Flent intro',
  startsAt: fromNow(2),
  endsAt: fromNow(2.5),
  cancelled: false,
  conferenceUrl: 'https://meet.google.com/abc-defg-hij',
  location: null,
  participants: [
    { email: 'ana@flent.io', name: 'Ana Reyes', rsvp: 'accepted' },
    { email: 'ben@flent.io', name: null, rsvp: 'tentative' },
  ],
  records: [{ id: 'c1', kind: 'company', name: 'Flent', objectSlug: null }],
  note: null,
  notes: [],
  artifacts: [
    {
      documentId: 'd1',
      role: 'transcript',
      name: 'intro transcript.txt',
      url: null,
      private: false,
    },
    {
      documentId: 'd2',
      role: 'recording_link',
      name: 'Recording',
      url: 'https://fathom.video/calls/42',
      private: false,
    },
  ],
  suggestions: [],
  nothingToNote: false,
}

/** The sheet's read, as `getMeetingSheet` answers it. */
type SheetRead = MeetingSheetData & { removal: MeetingRemoval | null }

/** The sheet's read around a window's read. */
const sheetOf = (
  meeting: MeetingDetail,
  over: Partial<Omit<SheetRead, 'meeting'>> = {},
): SheetRead => ({
  meeting,
  kind: 'meeting',
  firstMeeting: false,
  people: meeting.participants.map((p, i) => ({
    email: p.email,
    name: p.name ?? p.email,
    rsvp: p.rsvp,
    host: i === 0,
    new: i === 1,
    you: false,
    line: i === 0 ? 'Flent · CEO' : null,
  })),
  recent: { record: null, rows: [] },
  removal: null,
  ...over,
})

/** The sheet's read answers with `meeting`. */
const reads = (meeting: MeetingDetail, over = {}) =>
  fns.getMeetingSheet.mockResolvedValue(sheetOf(meeting, over))

const streamOf = (events: ReadonlyArray<PrepEvent>) =>
  new ReadableStream<PrepEvent>({
    start(controller) {
      for (const e of events) controller.enqueue(e)
      controller.close()
    },
  })

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset()
  navigate.mockReset()
  reads(DETAIL)
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

async function open(id: string | null = ID) {
  act(() => root.render(<MeetingDialog id={id} onOpenChange={() => {}} />))
  await settle()
}

const dialog = () => document.querySelector('[role="dialog"]')
const buttons = (label: string) =>
  [...document.querySelectorAll('button')].filter(
    (b) => b.textContent.trim() === label,
  )

describe('the meeting window', () => {
  it('shows replies as a square and a word and never offers to change them; Google Calendar is the way', async () => {
    await open()
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Flent intro')
    expect(text).toContain('Ana Reyes')
    expect(text).toContain('ben@flent.io')
    const ben = dialog()?.querySelector('[data-participant="ben@flent.io"]')
    const reply = ben?.querySelector('[data-reply]')
    expect(reply?.getAttribute('data-square')).toBe('dithered')
    expect(reply?.textContent).toBe('Maybe')
    expect(dialog()?.querySelector('select, input[type="radio"]')).toBeNull()
    const google = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Google Calendar ↗',
    )
    expect(google?.getAttribute('href')).toContain('calendar.google.com')
    // Two hours out, the call is not yet one to join from the head.
    expect(
      [...document.querySelectorAll('a')].some(
        (a) => a.textContent === 'Join ↗',
      ),
    ).toBe(false)
  })

  it('stands Join ↗ in the head within ten minutes of the start', async () => {
    reads({ ...DETAIL, startsAt: fromNow(0.1), endsAt: fromNow(0.6) })
    await open()
    const join = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Join ↗',
    )
    expect(join?.getAttribute('href')).toBe(
      'https://meet.google.com/abc-defg-hij',
    )
  })

  it("prints no People group with nobody in the room, and carries Join call and Google Calendar in the head's ···", async () => {
    reads({ ...DETAIL, participants: [] })
    await open()
    expect(dialog()?.querySelector('[aria-label="People"]')).toBeNull()
    const links = () =>
      [...document.querySelectorAll('a')].map((a) => a.textContent)
    // Rare verbs: at rest the head holds the `···`, not links.
    expect(links()).not.toContain('Open in Google Calendar ↗')
    const trigger = dialog()?.querySelector(
      '[data-slot="dialog-header"] [aria-label^="More for"]',
    )
    if (!(trigger instanceof HTMLElement)) throw new Error('no ···')
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    for (
      let i = 0;
      i < 20 && document.querySelector('[role="menu"]') === null;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(links()).toContain('Open in Google Calendar ↗')
    expect(links()).toContain('Join call ↗')
  })

  it('has one close, in the head after Open as a page, and prints no esc or ↵', async () => {
    await open()
    expect(buttons('Cancel')).toHaveLength(0)
    expect(buttons('Done')).toHaveLength(0)
    expect(document.querySelector('[data-slot="dialog-footer"]')).toBeNull()
    const head = dialog()?.querySelector('[data-slot="dialog-header"]')
    expect(head?.querySelector('[data-window-close]')).not.toBeNull()
    // The router's Link is a bare anchor here: Open as a page is the one to /meetings.
    expect(head?.querySelector('a[href="/meetings"]')).not.toBeNull()
    const text = dialog()?.textContent ?? ''
    expect(text).not.toMatch(/\besc\b/i)
    expect(text).not.toContain('↵')
  })

  it('leads its head on the large date leaf, the when-line under the title', async () => {
    await open()
    const head = dialog()?.querySelector('[data-slot="dialog-header"]')
    expect(head?.firstElementChild?.getAttribute('data-date-leaf')).toBe(
      'large',
    )
    expect(head?.querySelector('[data-when-line]')?.textContent).toMatch(
      / · \d\d:\d\d–\d\d:\d\d · \d+m/,
    )
  })

  it('stamps a first meeting, and a cancelled one in place of it with the title struck', async () => {
    reads(DETAIL, { firstMeeting: true })
    await open()
    expect(dialog()?.querySelector('[data-stamp]')?.textContent).toBe(
      'First meeting',
    )
    await open(null)
    reads({ ...DETAIL, cancelled: true }, { firstMeeting: true })
    await open()
    const stamp = dialog()?.querySelector('[data-stamp]')
    expect(stamp?.textContent).toBe('Cancelled')
    expect(stamp?.getAttribute('class')).toContain('stamp-destructive')
    expect(
      dialog()
        ?.querySelector('[data-slot="dialog-title"]')
        ?.getAttribute('class'),
    ).toContain('line-through')
  })

  it('reads a person as a name with HOST and NEW, a line under it, and the reply at its end', async () => {
    await open()
    const rail = dialog()?.querySelector('[data-meeting-rail]')
    const ana = rail?.querySelector('[data-participant="ana@flent.io"]')
    expect(ana?.querySelector('[data-name-mark="host"]')).not.toBeNull()
    expect(ana?.textContent).toContain('Flent · CEO')
    expect(ana?.querySelector('[data-reply]')?.textContent).toBe('Yes')
    const ben = rail?.querySelector('[data-participant="ben@flent.io"]')
    expect(ben?.querySelector('[data-name-mark="new"]')).not.toBeNull()
    // The address is a tooltip, never printed for a named person.
    expect(ana?.textContent).not.toContain('ana@flent.io')
  })

  it('shows no replies once the meeting is over', async () => {
    reads({ ...DETAIL, startsAt: fromNow(-2), endsAt: fromNow(-1.5) })
    await open()
    expect(dialog()?.querySelector('[data-reply]')).toBeNull()
  })

  it('lays cards left on bone and a rail of Where, People and Records right', async () => {
    await open()
    const rail = dialog()?.querySelector('[data-meeting-rail]')
    expect(
      [...(rail?.querySelectorAll(':scope > section') ?? [])].map((g) =>
        g.getAttribute('aria-label'),
      ),
    ).toEqual(['Where', 'People', 'Records'])
    expect(rail?.getAttribute('class')).toContain('@2xl:w-74')
    expect(rail?.getAttribute('class')).toContain('bg-bone')
    const where = rail?.querySelector('[data-where]')
    expect(where?.textContent).toBe('Google Meetabc-defg-hij')
    expect(rail?.textContent).toContain('Copy link')
    expect(rail?.textContent).toContain('Pin a record…')
  })

  it('leads a linked record on its kind icon, never the kind word', async () => {
    await open()
    const linked = dialog()?.querySelector('[aria-label="Records"]')
    const icon = linked?.querySelector('[data-kind-icon="company"]')
    expect(icon?.getAttribute('aria-label')).toBe('Company')
    expect(linked?.textContent).not.toMatch(/company/i)
  })

  it('opens the write-up in the note window when it sits over a record', async () => {
    reads({
      ...DETAIL,
      note: {
        id: NOTE,
        title: 'Flent intro',
        body: null,
        at: '2026-10-14T16:02:00.000Z',
        openIn: null,
        via: null,
      },
    } satisfies MeetingDetail)
    const opened: Array<string> = []
    act(() =>
      root.render(
        <MeetingDialog
          id={ID}
          onOpenChange={() => {}}
          onOpenNote={(noteId) => opened.push(noteId)}
        />,
      ),
    )
    await settle()
    const title = dialog()?.querySelector(`[data-note-link="${NOTE}"]`)
    if (!(title instanceof HTMLElement)) throw new Error('no note link')
    expect(title.textContent).toBe('Open note ›')
    act(() => title.click())
    expect(opened).toEqual([NOTE])
    expect(navigate).not.toHaveBeenCalled()
  })

  it("lists artifacts by role: a recording opens the provider, a transcript the file's window", async () => {
    await open()
    const recording = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Recording',
    )
    expect(recording?.getAttribute('href')).toBe(
      'https://fathom.video/calls/42',
    )
    expect(recording?.getAttribute('target')).toBe('_blank')
    navigate.mockResolvedValue(undefined)
    const transcript = buttons('intro transcript.txt')[0]
    await act(async () => transcript.click())
    // The file's window takes the meeting's place in the address.
    const search = navigate.mock.lastCall?.[0].search
    expect(search({ modal: 'meeting', id: 'm1' })).toEqual({
      modal: 'file',
      id: 'd1',
      page: undefined,
    })
  })

  it("reads a recorder's write-up inline with Open in Granola, and its second note as a bordered row, each marked Via Granola", async () => {
    reads({
      ...DETAIL,
      note: {
        id: NOTE,
        title: 'Flent intro',
        body: 'Raising a $3M seed.\n\nNext: data room.',
        at: '2026-10-14T16:02:00.000Z',
        openIn: { provider: 'Granola', url: 'https://notes.granola.ai/d/n1' },
        via: { tool: 'Granola', author: 'Anish' },
      },
      notes: [
        {
          id: 'n2',
          title: 'Granola notes · Priya',
          role: 'recorder_note',
          private: false,
          openIn: { provider: 'Granola', url: 'https://notes.granola.ai/d/n2' },
          via: { tool: 'Granola', author: 'Priya' },
        },
      ],
    } satisfies MeetingDetail)
    await open()
    expect(buttons('Write it up')).toHaveLength(0)
    const granola = [...document.querySelectorAll('a')].filter(
      (a) => a.textContent === 'Open in Granola ›',
    )
    expect(granola.map((a) => a.getAttribute('href'))).toEqual([
      'https://notes.granola.ai/d/n1',
      'https://notes.granola.ai/d/n2',
    ])
    expect(granola.every((a) => a.getAttribute('target') === '_blank')).toBe(
      true,
    )
    const writeUp = dialog()?.querySelector('[aria-label="Write-up"]')
    expect(writeUp?.querySelector('[data-write-up-body]')?.textContent).toBe(
      'Raising a $3M seed.\n\nNext: data room.',
    )
    expect(writeUp?.textContent).toContain('Granola notes · Priya')
    expect(
      writeUp?.querySelector('[data-card-head] [title]')?.getAttribute('title'),
    ).toBe('Via Granola · Anish')
    expect(writeUp?.textContent).toContain('Via Granola · Priya')
  })

  it('is one No write-up card with Write it up once it is over and nothing is written', async () => {
    reads({
      ...DETAIL,
      startsAt: fromNow(-2),
      endsAt: fromNow(-1.5),
      artifacts: [],
    })
    await open()
    const card = dialog()?.querySelector('[aria-label="No write-up"]')
    expect(card?.querySelector('[data-dither-noun="notes"]')).not.toBeNull()
    expect(buttons('Write it up')).toHaveLength(1)
    expect(dialog()?.querySelector('[aria-label="Write-up"]')).toBeNull()
    expect(dialog()?.querySelector('[aria-label="Brief"]')).toBeNull()
  })

  it('lists task suggestions as action items, with Add task and Skip', async () => {
    reads({
      ...DETAIL,
      suggestions: [
        { id: 's1', kind: 'task', summary: 'Send the deck', due: null },
      ],
    })
    fns.acceptSuggestion.mockResolvedValue({ ok: true })
    await open()
    const items = dialog()?.querySelector('[aria-label="Action items"]')
    expect(items?.querySelector('[data-card-head]')?.textContent).toBe(
      'Action items1',
    )
    expect(items?.textContent).toContain('Send the deck')
    await act(async () => buttons('Add task')[0].click())
    await settle()
    expect(fns.acceptSuggestion).toHaveBeenCalledWith({ data: { id: 's1' } })
  })

  it('offers no brief once the meeting has started', async () => {
    reads({
      ...DETAIL,
      startsAt: fromNow(-1),
      endsAt: fromNow(-0.5),
    })
    await open()
    expect(buttons('Brief')).toHaveLength(0)
    expect(fns.prepMeeting).not.toHaveBeenCalled()
    // Over, there is no call to join either.
    expect(
      [...document.querySelectorAll('a')].some((a) =>
        a.textContent.startsWith('Join'),
      ),
    ).toBe(false)
  })

  it('runs the brief on demand saying what it reads, keeps nothing, saves what it showed and opens it in Ask', async () => {
    await open()
    // At rest the card is the one button.
    const card = () => dialog()?.querySelector('[aria-label="Brief"]')
    expect(card()?.textContent).toBe('Brief')
    const feed: { at: ReadableStreamDefaultController<PrepEvent> | null } = {
      at: null,
    }
    fns.prepMeeting.mockResolvedValue(
      new ReadableStream<PrepEvent>({
        start(controller) {
          feed.at = controller
        },
      }),
    )
    await act(async () => buttons('Brief')[0].click())
    await settle()
    expect(fns.prepMeeting).toHaveBeenCalledWith({
      data: { interactionId: ID },
    })
    const send = (e: PrepEvent) => {
      if (feed.at === null) throw new Error('no stream')
      feed.at.enqueue(e)
    }
    send({
      type: 'route',
      sensitive: false,
      line: 'Anthropic · claude-opus-5',
      sources: 6,
    })
    await settle()
    expect(buttons('Reading 6 sources')).toHaveLength(1)
    expect(buttons('Reading 6 sources')[0].disabled).toBe(true)

    const body = 'Who: Ana Reyes [note:x].\nDeal: In diligence [note:x].'
    send({ type: 'text', text: body })
    send({
      type: 'done',
      body,
      refs: [
        { ref: 'note:x', label: 'Call notes', href: '/notes/x', entityId: 'x' },
      ],
      markdown:
        'Who: Ana Reyes (Call notes).\nDeal: In diligence (Call notes).',
    })
    await act(async () => feed.at?.close())
    await settle()
    expect(card()?.textContent).toContain('Written ')
    expect(card()?.textContent).toContain('Ana Reyes')
    // The route is said only when the gate sent it somewhere unusual.
    expect(card()?.textContent).not.toContain('claude-opus-5')

    fns.savePrepAsNote.mockResolvedValue({ noteId: NOTE })
    await act(async () => buttons('Save as note')[0].click())
    await settle()
    expect(fns.savePrepAsNote).toHaveBeenCalledWith({
      data: {
        interactionId: ID,
        markdown:
          'Who: Ana Reyes (Call notes).\nDeal: In diligence (Call notes).',
      },
    })
    // It stays put: the label says it is saved, and nothing navigates.
    expect(navigate).not.toHaveBeenCalled()
    expect(buttons('Saved as note')).toHaveLength(1)
    expect(buttons('Saved as note')[0].disabled).toBe(true)

    const chip = {
      kind: 'record' as const,
      id: 'c1',
      name: 'Flent',
      href: '/companies/c1',
    }
    fns.askAboutBrief.mockResolvedValue({ threadId: 't1', scope: [chip] })
    await act(async () => buttons('Ask about this')[0].click())
    await settle()
    expect(fns.askAboutBrief).toHaveBeenCalledWith({
      data: { interactionId: ID, body, route: 'Anthropic · claude-opus-5' },
    })
    expect(readDock()).toMatchObject({
      open: true,
      threadId: 't1',
      mentioned: [chip],
    })

    // Opened again, the card is back at rest until asked.
    await open(null)
    await open()
    expect(card()?.textContent).toBe('Brief')
  })

  it('cancels a brief whose stream arrives after the window closed', async () => {
    await open()
    let resolve: (s: ReadableStream<PrepEvent>) => void = () => {}
    fns.prepMeeting.mockReturnValue(
      new Promise<ReadableStream<PrepEvent>>((r) => {
        resolve = r
      }),
    )
    await act(async () => buttons('Brief')[0].click())
    await open(null)
    const cancel = vi.fn()
    resolve(
      new ReadableStream<PrepEvent>({
        pull() {
          return new Promise(() => {})
        },
        cancel,
      }),
    )
    await settle()
    expect(cancel).toHaveBeenCalled()
  })

  it('says a refusal in place, in the gate’s words', async () => {
    await open()
    fns.prepMeeting.mockResolvedValue(
      streamOf([
        {
          type: 'refused',
          line: 'Refused · Sensitive material is not sent to Anthropic (sensitivity inherited from Fund II); route the synthesize lane to a local model',
        },
      ]),
    )
    await act(async () => buttons('Brief')[0].click())
    await settle()
    const refused = dialog()?.querySelector('[data-prep-refused]')
    expect(refused?.textContent).toContain('inherited from Fund II')
    expect(buttons('Save as note')).toHaveLength(0)
  })
})

describe('applyPrepEvent', () => {
  it('keeps text only while running, and the route line and the time into done', () => {
    const running = applyPrepEvent(
      { phase: 'idle' },
      { type: 'route', sensitive: true, line: 'Sensitive · local', sources: 2 },
    )
    const more = applyPrepEvent(running, { type: 'text', text: 'a' })
    expect(
      applyPrepEvent(
        more,
        { type: 'done', body: 'A', refs: [], markdown: 'A' },
        new Date(2026, 10, 28, 9, 12),
      ),
    ).toEqual({
      phase: 'done',
      line: 'Sensitive · local',
      sensitive: true,
      body: 'A',
      refs: [],
      markdown: 'A',
      writtenAt: '09:12',
    })
  })
})
