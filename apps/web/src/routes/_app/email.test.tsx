import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type * as RouterModule from '@tanstack/react-router'
import type * as QueryModule from '@tanstack/react-query'
import { ClockProvider } from '#/components/clock'
import type { DraftRow, EmailThreadPage } from '#/lib/server-fns'

/**
 * The Email page under a memory router: Threads in week bands with three
 * lines a row and `Draft` before the day; the three filters and the foot's
 * paging each asking the server again; the selected thread in the right
 * pane at 1440 and in the window below the split; Drafts with its count,
 * `Saved <day>` and the mode line, its composer in the pane, a row's `···`
 * (Open, Delete draft…), `No drafts.` when there are none.
 */

const fns = vi.hoisted(() => ({
  listEmailThreads: vi.fn(),
  listEmailDrafts: vi.fn(),
  getEmailDraft: vi.fn(),
  openEmailCompose: vi.fn(),
  deleteEmailDraft: vi.fn(),
}))

vi.mock('#/lib/server-fns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...fns,
}))

// The thread and the composer have suites of their own; here they mark
// what the page opened.
vi.mock('#/components/email-dialog', () => ({
  EmailPane: ({ id }: { id: string }) => <div data-stub-pane={id} />,
  EmailDialog: ({ id }: { id: string | null }) =>
    id === null ? null : <div data-stub-window={id} />,
}))
vi.mock('#/components/email/draft-composer', () => ({
  DraftComposer: ({ initial }: { initial: { id: string } }) => (
    <div data-stub-composer={initial.id} />
  ),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, { error: () => undefined }),
}))

vi.setConfig({ hookTimeout: 90_000 })

const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 })
let createRoot: typeof CreateRoot
let router: typeof RouterModule
let query: typeof QueryModule
let page: { Route: RouterModule.AnyRoute }

beforeAll(async () => {
  for (const key of [
    'window',
    'document',
    'navigator',
    'localStorage',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLTextAreaElement',
    'Element',
    'Node',
    'NodeFilter',
    'SVGElement',
    'ShadowRoot',
    'DocumentFragment',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
  ] as const)
    vi.stubGlobal(key, win[key])
  vi.stubGlobal('self', win)
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('requestAnimationFrame', win.requestAnimationFrame.bind(win))
  vi.stubGlobal('cancelAnimationFrame', win.cancelAnimationFrame.bind(win))
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  router = await import('@tanstack/react-router')
  query = await import('@tanstack/react-query')
  page = await import('#/routes/_app/email')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

/** Thu 15 Oct 2026, mid-morning. */
const NOW = new Date(2026, 9, 15, 11, 0).toISOString()
const at = (day: number) => new Date(2026, 9, day, 10, 42).toISOString()

const T1 = '00000000-0000-4000-8000-0000000000a1'
const T2 = '00000000-0000-4000-8000-0000000000a2'
const T3 = '00000000-0000-4000-8000-0000000000a3'
const D1 = '00000000-0000-4000-8000-0000000000d1'

const thread = (over: Partial<EmailThreadPage['threads'][number]>) => ({
  id: T1,
  subject: 'Re: Series A data room access',
  at: at(15),
  messages: 1,
  attendees: [],
  sent: false,
  records: [],
  attachments: 0,
  attachmentNames: [],
  summary: null,
  privateBody: false,
  draft: false,
  ...over,
})

const PAGE: EmailThreadPage = {
  threads: [
    thread({
      id: T1,
      messages: 3,
      attendees: [
        { name: 'Priya Raman', self: false },
        { name: 'Dev Shah', self: false },
      ],
      records: [{ id: 'c1', name: 'Exponent', kind: 'company' }],
      attachments: 2,
      summary: 'Priya shared the data room link.',
    }),
    thread({
      id: T2,
      subject: 'Intro: Lattice Capital ↔ Exponent',
      at: at(13),
      draft: true,
    }),
    // A seeded email: no people, no summary, one message.
    thread({ id: T3, subject: 'Seeded hello', at: at(9) }),
  ],
  total: 312,
  nextCursor: 'cursor-2',
}

const DRAFTS: Array<DraftRow> = [
  {
    id: D1,
    mode: 'reply_all',
    subject: 'Re: Intro: Lattice Capital ↔ Exponent',
    to: [
      { email: 'arjun@lattice.example', name: 'Arjun Mehta' },
      { email: 'priya@exponent.example' },
      { email: 'dev@exponent.example' },
    ],
    updatedAt: at(13),
    notSent: false,
  },
  {
    id: '00000000-0000-4000-8000-0000000000d2',
    mode: 'new',
    subject: '',
    to: [],
    updatedAt: at(15),
    notSent: false,
  },
]

let root: Root

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset()
  fns.listEmailThreads.mockResolvedValue(PAGE)
  fns.listEmailDrafts.mockResolvedValue(DRAFTS)
  fns.openEmailCompose.mockResolvedValue({
    draft: null,
    to: [],
    record: null,
    signature: '',
  })
  fns.getEmailDraft.mockResolvedValue({
    ...DRAFTS[0],
    inReplyToId: T2,
    cc: [],
    bcc: [],
    bodyMd: '',
    attachments: [],
  })
  win.happyDOM.setViewport({ width: 1440, height: 900 })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.replaceChildren()
})

let history: RouterModule.RouterHistory

async function mount(url: string) {
  const {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
  } = router
  const options = page.Route.options
  const rootRoute = createRootRoute()
  const app = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    component: () => <Outlet />,
  })
  const route = createRoute({
    getParentRoute: () => app,
    path: 'email',
    ...(options.component === undefined
      ? {}
      : { component: options.component }),
    ...(options.validateSearch === undefined
      ? {}
      : { validateSearch: options.validateSearch }),
  })
  history = createMemoryHistory({ initialEntries: [url] })
  const r = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([route])]),
    history,
  })
  const client = new query.QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  await act(async () => {
    await r.load()
    root.render(
      <query.QueryClientProvider client={client}>
        <ClockProvider now={NOW}>
          <RouterProvider router={r} />
        </ClockProvider>
      </query.QueryClientProvider>,
    )
  })
  await settle()
}

async function settle() {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
}

const text = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((el) =>
    el.textContent.trim(),
  )

function click(el: Element | null | undefined) {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click')
  act(() => el.click())
}

const byText = (selector: string, label: string) =>
  Array.from(document.querySelectorAll(selector)).find(
    (el) => el.textContent.trim() === label,
  )

/** The URL's search, as the router wrote it. */
const search = () => history.location.search

describe('Threads', () => {
  it('lists the threads in week bands, three lines a row, Draft before the day', async () => {
    await mount('/email')
    expect(document.querySelector('h1')?.textContent).toBe('Email')
    expect(fns.listEmailThreads).toHaveBeenCalledWith({
      data: { filter: 'all', limit: 50 },
    })
    expect(text('[data-band] h3')).toEqual(['This week', 'Last week'])
    const row = (id: string) => document.querySelector(`[data-thread="${id}"]`)
    expect(row(T1)?.textContent).toContain('Re: Series A data room access3')
    expect(row(T1)?.textContent).toContain('10:42')
    expect(row(T1)?.querySelector('[data-people]')?.textContent).toBe(
      'Priya Raman, Dev Shah · Exponent',
    )
    expect(row(T1)?.querySelector('[data-clip]')?.textContent).toBe('2')
    expect(row(T1)?.querySelector('[data-summary]')?.textContent).toBe(
      'Priya shared the data room link.',
    )
    expect(row(T2)?.querySelector('[data-draft-mark]')?.textContent).toBe(
      'Draft',
    )
    expect(row(T2)?.textContent).toContain('Tue')
    // A bare row still reads its subject and its day.
    expect(row(T3)?.textContent).toBe('Seeded hello9 Oct')
    expect(text('[data-table-foot]')).toEqual(['3 of 312·Load 50 more'])
    // Nothing addressed: the first thread opens, so the pane is never bare.
    expect(search()).toContain(T1)
    expect(document.querySelector(`[data-stub-pane="${T1}"]`)).not.toBeNull()
  })

  it('keeps the thread the URL addresses instead of the first', async () => {
    await mount(`/email?id=${T2}`)
    expect(search()).toContain(T2)
    expect(document.querySelector(`[data-stub-pane="${T2}"]`)).not.toBeNull()
    expect(document.querySelector(`[data-stub-pane="${T1}"]`)).toBeNull()
  })

  it('asks again under each of the three filters', async () => {
    await mount('/email')
    for (const [label, filter] of [
      ['Mine', 'mine'],
      ['Shared with me', 'shared'],
      ['All', 'all'],
    ] as const) {
      click(byText('[role="radio"]', label))
      await settle()
      expect(fns.listEmailThreads).toHaveBeenLastCalledWith({
        data: { filter, limit: 50 },
      })
    }
    expect(search()).not.toContain('filter')
  })

  it('loads the next page from the cursor', async () => {
    fns.listEmailThreads.mockResolvedValueOnce(PAGE).mockResolvedValueOnce({
      threads: [
        thread({
          id: '00000000-0000-4000-8000-0000000000a4',
          subject: 'Older',
          at: at(1),
        }),
      ],
      total: 312,
      nextCursor: null,
    })
    await mount('/email')
    click(byText('button', 'Load 50 more'))
    await settle()
    expect(fns.listEmailThreads).toHaveBeenLastCalledWith({
      data: { filter: 'all', limit: 50, cursor: 'cursor-2' },
    })
    expect(text('[data-table-foot]')).toEqual(['4 of 312'])
  })

  it('opens the selected thread in the right pane at 1440', async () => {
    await mount('/email')
    click(document.querySelector(`[data-thread="${T2}"] button`))
    await settle()
    expect(search()).toContain(T2)
    expect(
      document
        .querySelector(`[data-thread="${T2}"]`)
        ?.hasAttribute('data-selected'),
    ).toBe(true)
    expect(document.querySelector(`[data-stub-pane="${T2}"]`)).not.toBeNull()
    expect(document.querySelector('[data-stub-window]')).toBeNull()
  })

  it('opens it in the email window below the split instead', async () => {
    win.happyDOM.setViewport({ width: 900, height: 900 })
    await mount('/email')
    // One pane: nothing opens until a row is picked.
    expect(document.querySelector('[data-stub-window]')).toBeNull()
    expect(search()).not.toContain('id=')
    click(document.querySelector(`[data-thread="${T1}"] button`))
    await settle()
    expect(document.querySelector(`[data-stub-window="${T1}"]`)).not.toBeNull()
    expect(document.querySelector('[data-stub-pane]')).toBeNull()
  })
})

describe('New email', () => {
  it('is the head’s pine split, opening the composer as a window over the page from the URL', async () => {
    await mount('/email?tab=drafts')
    const split = document.querySelector('[data-split-new]')
    expect(split?.getAttribute('data-split-new')).toBe('primary')
    click(byText('button', 'New email'))
    await settle()
    const params = new URLSearchParams(search())
    expect(params.get('modal')).toBe('email')
    expect(params.get('new')).toBe('1')
    expect(params.get('tab')).toBe('drafts')
    const draft = params.get('draft')
    expect(draft).toMatch(/^[0-9a-f-]{36}$/)
    expect(fns.openEmailCompose).toHaveBeenCalledWith({
      data: { draftId: draft, recordId: null },
    })
    const sheet = document.querySelector('[data-compose-window]')
    expect(sheet?.querySelector(`[data-stub-composer="${draft}"]`)).not.toBe(
      null,
    )
  })
})

describe('Drafts', () => {
  it('counts the drafts on the tab and lists them newest first with the mode line', async () => {
    await mount('/email?tab=drafts')
    const tab = byText('[role="tab"]', 'Drafts2')
    expect(tab?.getAttribute('aria-selected')).toBe('true')
    const rows = text('[data-draft]')
    expect(rows).toEqual([
      'Re: Intro: Lattice Capital ↔ ExponentSaved TueReply all · Arjun Mehta +2',
      '(no subject)Saved 10:42New email',
    ])
  })

  it('opens the selected draft’s composer in the pane', async () => {
    await mount('/email?tab=drafts')
    click(document.querySelector(`[data-draft="${D1}"] button`))
    await settle()
    expect(fns.getEmailDraft).toHaveBeenCalledWith({ data: { id: D1 } })
    expect(
      document.querySelector('[data-draft-pane] [data-pane-head] h2')
        ?.textContent,
    ).toBe('Re: Intro: Lattice Capital ↔ Exponent')
    expect(
      document.querySelector(`[data-stub-composer="${D1}"]`),
    ).not.toBeNull()
  })

  /** Opens a draft row's `···` and returns its items. */
  async function rowMenu(id: string) {
    const trigger = document.querySelector(
      `[data-draft="${id}"] [aria-label^="More for draft"]`,
    )
    if (!(trigger instanceof HTMLElement)) throw new Error('no ···')
    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await settle()
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  }

  it('gives each row a ···: Open and Delete draft…, each led by its mark', async () => {
    await mount('/email?tab=drafts')
    const items = await rowMenu(D1)
    expect(items.map((i) => i.textContent.trim())).toEqual([
      'Open',
      'Delete draft…',
    ])
    for (const item of items) expect(item.querySelector('svg')).not.toBeNull()
    click(items.at(0))
    await settle()
    expect(fns.getEmailDraft).toHaveBeenCalledWith({ data: { id: D1 } })
    expect(
      document.querySelector(`[data-stub-composer="${D1}"]`),
    ).not.toBeNull()
  })

  it('deletes a draft from its row after the composer’s confirm', async () => {
    fns.deleteEmailDraft.mockResolvedValue({ ok: true })
    await mount('/email?tab=drafts')
    const items = await rowMenu(D1)
    click(items.find((i) => i.textContent.trim() === 'Delete draft…'))
    await settle()
    const dialog = document.querySelector(
      '[role="alertdialog"], [role="dialog"]',
    )
    expect(
      dialog?.querySelector('[data-slot="dialog-title"]')?.textContent,
    ).toBe('Delete this draft?')
    expect(fns.deleteEmailDraft).not.toHaveBeenCalled()
    fns.listEmailDrafts.mockResolvedValue(DRAFTS.slice(1))
    click(byText('button', 'Delete'))
    await settle()
    expect(fns.deleteEmailDraft).toHaveBeenCalledWith({ data: { id: D1 } })
    expect(document.querySelector(`[data-draft="${D1}"]`)).toBeNull()
  })

  it('leads a draft whose send failed with the crimson square and Not sent', async () => {
    fns.listEmailDrafts.mockResolvedValue([
      { ...DRAFTS[1], notSent: true },
      DRAFTS[0],
    ])
    await mount('/email?tab=drafts')
    const first = document.querySelector('[data-draft]')
    expect(first?.textContent).toBe('(no subject)Not sentNew email')
    expect(first?.querySelector('.bg-destructive')).not.toBeNull()
    expect(
      document.querySelector(`[data-draft="${D1}"] .bg-destructive`),
    ).toBeNull()
  })

  it('opens a draft addressed by the URL in the pane, as Today’s Open › does', async () => {
    await mount(`/email?tab=drafts&id=${D1}`)
    expect(fns.getEmailDraft).toHaveBeenCalledWith({ data: { id: D1 } })
    expect(
      document.querySelector(`[data-draft-pane] [data-stub-composer="${D1}"]`),
    ).not.toBeNull()
  })

  it('says so when there are none', async () => {
    fns.listEmailDrafts.mockResolvedValue([])
    await mount('/email?tab=drafts')
    expect(text('[data-list-state="none"]')).toEqual(['No drafts.'])
    expect(byText('[role="tab"]', 'Drafts')).toBeDefined()
  })
})
