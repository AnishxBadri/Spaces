import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClockProvider } from '#/components/clock'
import type { RecordDocument } from '#/components/files/types'
import { shownReadouts } from '#/lib/records/overview'
import { latestThreads, threadPeople } from '#/lib/timeline/threads'
import { RecordOverview } from './record-overview'
import { ThreadRow } from './thread-row'
import type { ThreadItem } from './thread-row'

/**
 * A record's Overview: only the readouts with a value, then the Tasks,
 * Latest and Files bands, each ending on a way to its tab — and on a first
 * run nothing but `Tasks +`, `Interactions +`, `Files +`. The thread row
 * never lists its viewer and reads `To <name>` on a row the viewer sent.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/x' })
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

type OpenTask = {
  id: string
  content: string
  dueDate: string | null
  assigneeName: string
}

const tasks = vi.hoisted(() => {
  const current: Array<OpenTask> = []
  return { current }
})

vi.mock('#/lib/server-fns', () => ({
  listEntityTasks: vi.fn(() => Promise.resolve(tasks.current)),
  setTaskDone: vi.fn(() => Promise.resolve()),
}))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
  useSearch: () => ({}),
  useNavigate: () => () => Promise.resolve(),
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}))
// The windows have their own suites; here only what Overview draws.
vi.mock('#/components/email-dialog', () => ({ EmailModal: () => null }))
vi.mock('#/components/document-preview', () => ({
  DocumentPreview: () => null,
}))
vi.mock('#/components/files/viewer-sidebar', () => ({
  FileViewerSidebar: () => null,
}))
vi.mock('#/components/task-composer', () => ({
  TaskComposer: ({ trigger }: { trigger: ReactNode }) => trigger,
}))

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  tasks.current = []
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const NOW = '2026-10-26T12:00:00.000Z'
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

async function mount(node: ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<ClockProvider now={NOW}>{node}</ClockProvider>))
  await flush()
  return host
}

const cls = (el: Element | null | undefined) =>
  (el?.getAttribute('class') ?? '').split(/\s+/)

const thread = (
  id: string,
  at: string,
  extra: Partial<ThreadItem & { threadId: string | null }> = {},
): ThreadItem & { type: 'interaction'; threadId: string | null } => ({
  type: 'interaction',
  id,
  kind: 'email',
  subject: `Subject ${id}`,
  noteId: null,
  privateBody: false,
  at,
  attendees: [],
  sent: false,
  attachments: 0,
  summary: null,
  threadId: null,
  ...extra,
})

function file(id: string, createdAt: string): RecordDocument {
  return {
    id,
    filename: `${id}.pdf`,
    mime: 'application/pdf',
    sizeBytes: 1000,
    kind: 'other',
    extractionStatus: 'done',
    extractionError: null,
    createdAt,
    uploadedBy: null,
    blobSha: 'a'.repeat(64),
    url: null,
    externalUrl: null,
    externalStatus: null,
    sourcePath: null,
    bindingId: null,
    externalId: null,
    follow: null,
    canFollow: false,
    snippet: null,
    uploadedByName: 'Priya Raman',
    lastRun: null,
    sourceClass: 'manual',
    sourceCapability: null,
    filedIn: [],
    replacedBy: null,
    email: null,
  }
}

const RECORD = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: 'Flent',
  kind: 'company',
}

describe('the readouts', () => {
  it('keeps only the readouts that have a value: no dash, no 0, no null', () => {
    expect(
      shownReadouts([
        { label: 'Last contact', value: '4 Oct' },
        { label: 'Next meeting', value: '—' },
        { label: 'Moving, 30 days', value: 0 },
        { label: 'Ownership', value: null },
        { label: 'Round', value: '' },
        { label: 'Days in stage', value: 12, tone: 'bad' },
      ]),
    ).toEqual([
      { label: 'Last contact', value: '4 Oct' },
      { label: 'Days in stage', value: '12', tone: 'bad' },
    ])
  })

  it('draws a 76px row: a 220px first cell ruled on its right, then 180px cells', async () => {
    const el = await mount(
      <RecordOverview
        record={RECORD}
        readouts={[
          { label: 'Last contact', value: '4 Oct' },
          { label: 'Next meeting', value: '—' },
          { label: 'Close', value: '1 Oct', tone: 'bad' },
        ]}
        timeline={[]}
        documents={[]}
        onTab={() => {}}
      />,
    )
    const row = el.querySelector('[data-overview-readouts]')
    expect(cls(row)).toEqual(
      expect.arrayContaining(['h-19', 'px-3', 'border-b', 'border-rule']),
    )
    const cells = [...el.querySelectorAll('[data-readout]')]
    expect(cells.map((c) => c.textContent)).toEqual([
      '4 OctLast contact',
      '1 OctClose',
    ])
    expect(cls(cells[0])).toEqual(
      expect.arrayContaining(['w-55', 'border-r', 'border-rule']),
    )
    expect(cls(cells[1])).toEqual(expect.arrayContaining(['w-45', 'pl-4']))
    expect(cls(cells[1]?.firstElementChild)).toEqual(
      expect.arrayContaining(['mono', 'text-page', 'text-destructive']),
    )
    expect(cls(cells[1]?.lastElementChild)).toEqual(
      expect.arrayContaining(['text-label', 'text-graphite']),
    )
    expect(el.textContent).not.toContain('Next meeting')
  })
})

describe('the three bands', () => {
  it('lists the open tasks, the latest three threads and the latest three files, each with its way out', async () => {
    tasks.current = [
      {
        id: 't1',
        content: 'Send the term sheet',
        dueDate: '2026-10-20',
        assigneeName: 'Anish',
      },
    ]
    const tabs: Array<string> = []
    const el = await mount(
      <RecordOverview
        record={RECORD}
        readouts={[]}
        timeline={[
          thread('a', '2026-10-20T10:00:00.000Z', { threadId: 'T1' }),
          thread('b', '2026-10-21T10:00:00.000Z', { threadId: 'T1' }),
          thread('c', '2026-10-19T10:00:00.000Z'),
          thread('d', '2026-10-18T10:00:00.000Z'),
          thread('e', '2026-10-01T10:00:00.000Z'),
          { type: 'macro' },
        ]}
        documents={[
          file('old', '2026-09-01T10:00:00.000Z'),
          file('new', '2026-10-12T10:00:00.000Z'),
          file('mid', '2026-10-02T10:00:00.000Z'),
          file('older', '2026-08-01T10:00:00.000Z'),
        ]}
        onTab={(t) => tabs.push(t)}
      />,
    )
    const bands = [...el.querySelectorAll('[data-band]')].map(
      (b) => b.textContent,
    )
    expect(bands).toEqual([
      'TasksAll tasks ›',
      'LatestAll interactions ›',
      'FilesAll files ›',
    ])
    expect(el.querySelector('a[href^="/tasks"]')?.getAttribute('href')).toBe(
      `/tasks?record=${RECORD.id}`,
    )

    const task = el.querySelector('[data-task="t1"]')
    expect(cls(task)).toContain('h-ledger-row')
    expect(task?.textContent).toContain('Send the term sheet')
    expect(cls(task?.querySelector('[data-due]'))).toEqual(
      expect.arrayContaining(['w-18', 'mono', 'text-destructive']),
    )
    expect(el.textContent).toContain('Add a task…')

    // Thread T1 is its newest message with a count of two.
    const threads = [...el.querySelectorAll('[data-thread]')]
    expect(threads.map((t) => t.getAttribute('data-thread'))).toEqual([
      'b',
      'c',
      'd',
    ])
    expect(threads[0]?.querySelector('[data-messages]')?.textContent).toBe('2')
    expect(threads[1]?.querySelector('[data-messages]')).toBeNull()

    const files = [...el.querySelectorAll('[data-file]')]
    expect(files.map((f) => f.getAttribute('data-file'))).toEqual([
      'new',
      'mid',
      'old',
    ])
    expect(files[0]?.textContent).toBe('PDFnew.pdfPriya Raman12 Oct')
    expect(cls(files[0]?.querySelector('[data-filed-by]'))).toContain('w-63')

    const all = [...el.querySelectorAll('button')].filter((b) =>
      /^All (interactions|files) ›$/.test(b.textContent),
    )
    for (const b of all)
      act(() => {
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    expect(tabs).toEqual(['interactions', 'files'])
    expect(el.querySelector('[data-empty-row]')).toBeNull()
  })

  it('reads on a first run as Tasks +, Interactions +, Files + and nothing else', async () => {
    const el = await mount(
      <RecordOverview
        record={RECORD}
        readouts={[{ label: 'Moving, 30 days', value: 0 }]}
        timeline={[{ type: 'attrs' }]}
        documents={[]}
        onTab={() => {}}
      />,
    )
    expect(el.querySelector('[data-overview-readouts]')).toBeNull()
    expect(el.querySelector('[data-band]')).toBeNull()
    expect(
      [...el.querySelectorAll('[data-empty-row]')].map((r) => r.textContent),
    ).toEqual(['Tasks+', 'Interactions+', 'Files+'])
    expect(el.textContent).toBe('Tasks+Interactions+Files+')
  })
})

describe('a thread row', () => {
  const ada = { name: 'Ada Lovelace', self: false }
  const me = { name: 'Anish Badri', self: true }

  it('never lists the viewer, and reads To <name> on a row the viewer sent', async () => {
    expect(threadPeople({ attendees: [me, ada], sent: false })).toBe(
      'Ada Lovelace',
    )
    expect(threadPeople({ attendees: [me, ada], sent: true })).toBe(
      'To Ada Lovelace',
    )
    expect(threadPeople({ attendees: [me], sent: true })).toBe('')

    const el = await mount(
      <ul>
        <ThreadRow
          item={{
            ...thread('s', '2026-10-21T10:00:00.000Z'),
            attendees: [me, ada],
            sent: true,
            attachments: 2,
            summary: 'Sends the Q3 deck.',
          }}
          messages={3}
        />
      </ul>,
    )
    const row = el.querySelector('[data-thread="s"]')
    expect(cls(row)).toEqual(expect.arrayContaining(['px-3', 'py-2.25']))
    expect(row?.querySelector('[data-people]')?.textContent).toBe(
      'To Ada Lovelace',
    )
    expect(cls(row?.querySelector('[data-people]'))).toEqual(
      expect.arrayContaining(['w-50', 'text-label', 'text-graphite']),
    )
    expect(row?.textContent).not.toContain('Anish')
    expect(row?.querySelector('[data-messages]')?.textContent).toBe('3')
    expect(row?.querySelector('[data-clip]')?.textContent).toBe('2')
    expect(row?.querySelector('time')?.textContent).toBe('21 Oct')
    const summary = row?.querySelector('[data-summary]')
    expect(summary?.textContent).toBe('Sends the Q3 deck.')
    expect(cls(summary)).toEqual(
      expect.arrayContaining(['pl-7', 'pr-81', 'text-label', 'text-graphite']),
    )
  })

  it('draws no second line without a summary', async () => {
    const el = await mount(
      <ul>
        <ThreadRow item={thread('n', '2026-10-21T10:00:00.000Z')} />
      </ul>,
    )
    expect(el.querySelector('[data-summary]')).toBeNull()
    expect(el.querySelector('[data-messages]')).toBeNull()
  })

  it('picks the newest threads, a row with no thread id its own', () => {
    const rows = [
      { id: 'a', threadId: 'T', at: '2026-10-01' },
      { id: 'b', threadId: null, at: '2026-10-03' },
      { id: 'c', threadId: 'T', at: '2026-10-04' },
      { id: 'd', threadId: null, at: '2026-09-01' },
    ]
    expect(latestThreads(rows, 2).map((t) => [t.row.id, t.messages])).toEqual([
      ['c', 2],
      ['b', 1],
    ])
  })
})
