import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingDetail, PrepEvent } from '#/lib/server-fns'
import { MeetingDialog, applyPrepEvent } from './meeting-dialog'

/**
 * The meeting window: RSVPs shown and never editable with "Open in
 * Google" the only way to change one; artifacts by role; one close in the
 * foot and no `esc` or `↵` printed; Prep streamed on demand, never kept, and
 * "Save as note" sending the brief that was shown; a refusal said in place.
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
  getMeeting: vi.fn(),
  prepMeeting: vi.fn(),
  savePrepAsNote: vi.fn(),
  acceptSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  pinMeetingRecord: vi.fn(),
  searchEntities: vi.fn(),
  writeUpInteraction: vi.fn(),
  getDocumentPreview: vi.fn(),
  getDocumentDownloadUrl: vi.fn(),
  getDocumentText: vi.fn(),
}))
const navigate = vi.hoisted(() => vi.fn())

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({
    invalidate: () => Promise.resolve(),
    navigate,
  }),
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
/** An instant `hours` from now: Prep is only for a meeting still ahead. */
const fromNow = (hours: number) =>
  new Date(Date.now() + hours * HOUR).toISOString()

const DETAIL: MeetingDetail = {
  id: ID,
  title: 'Flent intro',
  startsAt: fromNow(2),
  endsAt: fromNow(2.5),
  cancelled: false,
  conferenceUrl: 'https://meet.google.com/abc-defg-hij',
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
}

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
  fns.getMeeting.mockResolvedValue(DETAIL)
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
  it('shows RSVPs and never offers to change them; Open in Google is the way', async () => {
    await open()
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Flent intro')
    expect(text).toContain('Ana Reyes')
    expect(text).toContain('✓ Accepted')
    expect(text).toContain('ben@flent.io')
    expect(text).toContain('? Maybe')
    expect(dialog()?.querySelector('select, input[type="radio"]')).toBeNull()
    const google = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Open in Google ›',
    )
    expect(google?.getAttribute('href')).toContain('calendar.google.com')
    // The conference link is the head's one action.
    const join = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Join call ›',
    )
    expect(join?.getAttribute('href')).toBe(
      'https://meet.google.com/abc-defg-hij',
    )
  })

  it('has one close, in the foot, and prints no esc or ↵', async () => {
    await open()
    expect(buttons('Cancel')).toHaveLength(1)
    expect(
      buttons('Cancel')[0].closest('[data-slot="dialog-footer"]'),
    ).not.toBeNull()
    const text = dialog()?.textContent ?? ''
    expect(text).not.toMatch(/\besc\b/i)
    expect(text).not.toContain('↵')
  })

  it('lists artifacts by role: a recording opens the provider, a transcript the Files preview', async () => {
    await open()
    const recording = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Recording',
    )
    expect(recording?.getAttribute('href')).toBe(
      'https://fathom.video/calls/42',
    )
    expect(recording?.getAttribute('target')).toBe('_blank')
    fns.getDocumentPreview.mockResolvedValue(null)
    const transcript = buttons('intro transcript.txt')[0]
    await act(async () => transcript.click())
    expect(fns.getDocumentPreview).toHaveBeenCalledWith({ data: { id: 'd1' } })
  })

  it("reads a recorder's write-up inline with Open in Granola, and its second note as a bordered row, each marked Via Granola", async () => {
    fns.getMeeting.mockResolvedValue({
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
    expect(buttons('Write up')).toHaveLength(0)
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
    expect(writeUp?.textContent).toContain('Flent intro')
    expect(writeUp?.querySelector('[data-write-up-body]')?.textContent).toBe(
      'Raising a $3M seed.\n\nNext: data room.',
    )
    expect(writeUp?.textContent).toContain('Granola notes · Priya')
    expect(writeUp?.querySelector('[data-write-up-line]')?.textContent).toMatch(
      /^Via Granola · Anish · /,
    )
    expect(writeUp?.textContent).toContain('Via Granola · Priya')
  })

  it('is one Write-up + row with nothing written', async () => {
    fns.getMeeting.mockResolvedValue({ ...DETAIL, artifacts: [] })
    await open()
    const writeUp = dialog()?.querySelector('[aria-label="Write-up"]')
    expect(writeUp?.querySelector('[data-empty-row]')?.textContent).toBe(
      'Write-up+',
    )
  })

  it('lists task suggestions as action items, with Add task and Skip', async () => {
    fns.getMeeting.mockResolvedValue({
      ...DETAIL,
      suggestions: [
        { id: 's1', kind: 'task', summary: 'Send the deck', due: null },
      ],
    })
    fns.acceptSuggestion.mockResolvedValue({ ok: true })
    await open()
    const items = dialog()?.querySelector('[aria-label="Action items"]')
    expect(items?.textContent).toContain('1 in Review')
    expect(items?.textContent).toContain('Send the deck')
    await act(async () => buttons('Add task')[0].click())
    await settle()
    expect(fns.acceptSuggestion).toHaveBeenCalledWith({ data: { id: 's1' } })
  })

  it('offers no Prep once the meeting has started, not even from the row', async () => {
    fns.getMeeting.mockResolvedValue({
      ...DETAIL,
      startsAt: fromNow(-1),
      endsAt: fromNow(-0.5),
    })
    act(() =>
      root.render(<MeetingDialog id={ID} prepOnOpen onOpenChange={() => {}} />),
    )
    await settle()
    expect(buttons('Prep')).toHaveLength(0)
    expect(fns.prepMeeting).not.toHaveBeenCalled()
    // Over, there is no call to join either.
    expect(
      [...document.querySelectorAll('a')].some(
        (a) => a.textContent === 'Join call ›',
      ),
    ).toBe(false)
  })

  it('streams Prep on demand, keeps nothing, and saves the brief it showed as a note', async () => {
    await open()
    expect(dialog()?.querySelector('[aria-label="Prep"]')).toBeNull()
    fns.prepMeeting.mockResolvedValue(
      streamOf([
        { type: 'route', sensitive: false, line: 'Anthropic · claude-opus-5' },
        { type: 'text', text: 'Flent is ' },
        { type: 'text', text: 'raising [note:x].' },
        { type: 'done', markdown: 'Flent is raising (Call notes).' },
      ]),
    )
    await act(async () => buttons('Prep')[0].click())
    await settle()
    expect(fns.prepMeeting).toHaveBeenCalledWith({
      data: { interactionId: ID },
    })
    const prep = dialog()?.querySelector('[aria-label="Prep"]')
    expect(prep?.textContent).toContain('Anthropic · claude-opus-5')
    expect(prep?.textContent).toContain('Flent is raising (Call notes).')

    expect(
      document.querySelector('[data-slot="dialog-footer"]')?.textContent,
    ).toContain('Not kept unless saved')
    fns.savePrepAsNote.mockResolvedValue({ noteId: NOTE })
    await act(async () => buttons('Save as note')[0].click())
    await settle()
    expect(fns.savePrepAsNote).toHaveBeenCalledWith({
      data: { interactionId: ID, markdown: 'Flent is raising (Call notes).' },
    })
    // It stays put: the label says it is saved, and nothing navigates.
    expect(navigate).not.toHaveBeenCalled()
    expect(buttons('Saved as note')).toHaveLength(1)
    expect(buttons('Saved as note')[0].disabled).toBe(true)

    // Opened again, the window shows no Prep until asked.
    await open(null)
    await open()
    expect(dialog()?.querySelector('[aria-label="Prep"]')).toBeNull()
    expect(buttons('Prep')).toHaveLength(1)
  })

  it('cancels a Prep whose stream arrives after the window closed', async () => {
    await open()
    let resolve: (s: ReadableStream<PrepEvent>) => void = () => {}
    fns.prepMeeting.mockReturnValue(
      new Promise<ReadableStream<PrepEvent>>((r) => {
        resolve = r
      }),
    )
    await act(async () => buttons('Prep')[0].click())
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
    await act(async () => buttons('Prep')[0].click())
    await settle()
    const refused = dialog()?.querySelector('[data-prep-refused]')
    expect(refused?.textContent).toContain('inherited from Fund II')
    expect(buttons('Save as note')).toHaveLength(0)
  })
})

describe('applyPrepEvent', () => {
  it('keeps text only while running, and the route line into done', () => {
    const running = applyPrepEvent(
      { phase: 'idle' },
      { type: 'route', sensitive: true, line: 'Sensitive · local' },
    )
    const more = applyPrepEvent(running, { type: 'text', text: 'a' })
    expect(applyPrepEvent(more, { type: 'done', markdown: 'A' })).toEqual({
      phase: 'done',
      line: 'Sensitive · local',
      sensitive: true,
      markdown: 'A',
    })
  })
})
