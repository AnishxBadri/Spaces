import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingDetail, PrepEvent } from '#/lib/server-fns'
import { MeetingDialog, applyPrepEvent } from './meeting-dialog'

/**
 * The meeting window (D68, M2): RSVPs shown and never editable with "Open in
 * Google" the only way to change one; artifacts by role; one close in the
 * foot and no `esc` or `↵` printed; Prep streamed on demand, never kept, and
 * "Save as note" sending the brief that was shown; a refusal said in place.
 * - A happy-dom window's DOM globals are installed by hand before React
 *   loads, as `storage-picker.test.tsx` does.
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

const DETAIL: MeetingDetail = {
  id: ID,
  title: 'Flent intro',
  startsAt: '2026-10-14T09:30:00.000Z',
  endsAt: '2026-10-14T10:00:00.000Z',
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
    },
    {
      documentId: 'd2',
      role: 'recording_link',
      name: 'Recording',
      url: 'https://fathom.video/calls/42',
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
    expect(text).toContain('✓ accepted')
    expect(text).toContain('ben@flent.io')
    expect(text).toContain('? maybe')
    expect(dialog()?.querySelector('select, input[type="radio"]')).toBeNull()
    const google = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Open in Google ›',
    )
    expect(google?.getAttribute('href')).toContain('calendar.google.com')
    // The conference link is the head's one action.
    const join = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'join call ›',
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

  it("offers Open note and Open in Granola for a recorder's write-up, and its second note", async () => {
    fns.getMeeting.mockResolvedValue({
      ...DETAIL,
      note: {
        id: NOTE,
        title: 'Flent intro',
        openIn: { provider: 'Granola', url: 'https://notes.granola.ai/d/n1' },
      },
      notes: [
        {
          id: 'n2',
          title: 'Granola notes · Priya',
          role: 'recorder_note',
          private: false,
          openIn: { provider: 'Granola', url: 'https://notes.granola.ai/d/n2' },
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
    expect(writeUp?.textContent).toContain('Granola notes · Priya')
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

    fns.savePrepAsNote.mockResolvedValue({ noteId: NOTE })
    await act(async () => buttons('Save as note')[0].click())
    await settle()
    expect(fns.savePrepAsNote).toHaveBeenCalledWith({
      data: { interactionId: ID, markdown: 'Flent is raising (Call notes).' },
    })
    expect(navigate).toHaveBeenCalledWith({
      to: '/notes/$noteId',
      params: { noteId: NOTE },
    })

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
