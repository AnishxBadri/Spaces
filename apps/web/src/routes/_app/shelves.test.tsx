import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
import type { RouteComponent } from '@tanstack/react-router'
import { ClockProvider } from '#/components/clock'

/**
 * Deals, Portfolio and Files, walked under a memory router whose ids mirror
 * the app's:
 * - Deals: the `Table | Board` Segmented in the bar persists, the Stage chip
 *   narrows the rows, and the board prints its column heads, cards and drop
 *   target in the board's words;
 * - Portfolio: no tab bar, the count in the title, and Record a check
 *   writes an investment against the company it picks;
 * - Files: the kind tabs with their counts, `Unfiled` as the first band,
 *   and the line under a row's name — its first line of text, `Reading
 *   text`, or why it was not read with `Read again`.
 */

const fns = vi.hoisted(() => ({
  countViews: vi.fn(async () => ({})),
  searchEntities: vi.fn(),
  addInvestment: vi.fn(),
  listHoldings: vi.fn(),
  reExtractDocument: vi.fn(),
}))

vi.mock('#/lib/server-fns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...fns,
}))

vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, {
    error: () => undefined,
    success: () => undefined,
    message: () => undefined,
  }),
}))

vi.setConfig({ hookTimeout: 90_000 })

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let router: typeof RouterModule
const pages = new Map<string, RouteComponent>()

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
    'HTMLSelectElement',
    'HTMLFormElement',
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
  const modules = {
    deals: await import('#/routes/_app/deals'),
    portfolio: await import('#/routes/_app/portfolio'),
    files: await import('#/routes/_app/files'),
  }
  for (const [path, mod] of Object.entries(modules)) {
    const component = mod.Route.options.component
    if (component === undefined) throw new Error(`${path} has no component`)
    pages.set(path, component)
  }
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.replaceChildren()
})

const NOW = '2026-10-26T09:00:00.000Z'
const OBJECT_ID = '00000000-0000-4000-8000-0000000000f1'
const ME = { id: 'u-admin', role: 'admin' }

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const opt = (key: string, label: string, group: string) => ({
  id: key,
  label,
  group,
  color: 'slate',
})

const DEAL_REGISTRY = [
  {
    slug: 'stage',
    name: 'Stage',
    type: 'status',
    isSystem: true,
    options: {
      options: [
        opt('screening', 'Screening', 'active'),
        opt('diligence', 'Diligence', 'active'),
        opt('early_revisit', 'Early — revisit', 'parked'),
        opt('passed', 'Passed', 'closed'),
      ],
    },
  },
  {
    slug: 'value',
    name: 'Value',
    type: 'currency',
    isSystem: true,
    options: { code: 'USD' },
  },
  {
    slug: 'source',
    name: 'Source',
    type: 'select',
    isSystem: true,
    options: { options: [{ id: 'inbound', label: 'Inbound', color: 'blue' }] },
  },
  {
    slug: 'close_date',
    name: 'Close date',
    type: 'date',
    isSystem: true,
    options: null,
  },
]

const NO_STATS = { lastContact: null, lastEmail: null, nextMeeting: null }
const deal = (n: number, name: string, values: Record<string, unknown>) => ({
  id: id(n),
  name,
  values,
  createdAt: '2026-10-01T09:00:00.000Z',
  stats: NO_STATS,
})

const DEALS = [
  deal(1, 'Flent seed', {
    stage: 'diligence',
    value: 150_000,
    source: 'inbound',
    close_date: '2026-11-15',
  }),
  deal(2, 'Zolo A', { stage: 'screening', value: 350_000 }),
  deal(3, 'Nestaway bridge', { stage: 'passed' }),
]

const dealsData = () => ({
  deals: { rows: DEALS, refNames: {}, userNames: {}, pictures: {} },
  registry: DEAL_REGISTRY,
  funnel: {
    medianDaysInStage: { diligence: 4 },
    daysInStage: [{ id: id(1), days: 3 }],
  },
  views: [],
  counts: {},
  objectId: OBJECT_ID,
  me: ME,
})

const holding = (n: number, companyName: string) => ({
  id: id(100 + n),
  companyId: id(200 + n),
  companyName,
  metrics: { ok: false, missingRates: [] },
  ownership: { kind: 'none' },
})

const portfolioData = () => ({
  holdings: [holding(1, 'Flent'), holding(2, 'Zolo')],
  rollup: {
    costBasis: 0,
    realized: 0,
    unrealized: 0,
    moic: null,
    grossXirr: null,
    excludedForMissingRates: [],
  },
  baseCurrency: 'USD',
})

const doc = (n: number, filename: string, over: Record<string, unknown>) => ({
  id: id(300 + n),
  filename,
  kind: 'other',
  mime: 'application/pdf',
  sizeBytes: 2048,
  blobSha: 'a'.repeat(64),
  url: null,
  externalUrl: null,
  extractionStatus: 'done',
  extractionError: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  unfiled: false,
  firstLine: null,
  pages: null,
  words: null,
  versionAt: null,
  records: [],
  spaces: [],
  source: { via: 'upload', by: null },
  from: 'upload',
  addedBy: null,
  hit: null,
  guess: null,
  hasOlder: false,
  sourceCapability: null,
  sourcePath: null,
  inSyncedFolder: false,
  versions: 1,
  ...over,
})

const filesData = () => ({
  rows: [
    doc(4, 'Term sheet.docx', {
      unfiled: true,
      createdAt: '2026-10-26T08:00:00.000Z',
      guess: {
        target: { kind: 'record', entityId: id(900) },
        name: 'Flent',
        kind: 'company',
        object: null,
        parents: [],
      },
    }),
    doc(1, 'Deck.pdf', { firstLine: 'Leases under management' }),
    doc(2, 'Memo.pdf', { extractionStatus: 'pending' }),
    doc(3, 'Scan.pdf', {
      extractionStatus: 'failed',
      extractionError: 'no text layer and OCR failed',
    }),
  ],
  total: 48,
  unfiled: 3,
  places: 0,
  groups: {},
  named: { under: null, by: null },
  counts: {
    all: 48,
    deck: 12,
    cap_table: 0,
    dd: 3,
    legal: 0,
    article: 2,
    other: 31,
  },
})

const LOADERS: Record<string, () => object> = {
  deals: dealsData,
  portfolio: portfolioData,
  files: filesData,
}

async function mount(path: string) {
  const {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
  } = router
  const rootRoute = createRootRoute()
  const app = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    component: () => <Outlet />,
  })
  const component = pages.get(path)
  const loader = Object.hasOwn(LOADERS, path) ? LOADERS[path] : undefined
  if (component === undefined || loader === undefined)
    throw new Error(`no page ${path}`)
  const route = createRoute({
    getParentRoute: () => app,
    path,
    component,
    loader,
  })
  const r = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([route])]),
    history: createMemoryHistory({ initialEntries: [`/${path}`] }),
  })
  await act(async () => {
    await r.load()
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ClockProvider now={NOW}>
          <RouterProvider router={r} />
        </ClockProvider>
      </QueryClientProvider>,
    )
  })
}

/** Turn the event loop inside `act` until `done` holds, or fail naming `what`. */
async function until(what: string, done: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (done()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  throw new Error(`never ${what}`)
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').trim()
const title = () => document.querySelector('h1')?.textContent

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const byText = (selector: string, words: string) =>
  [...document.querySelectorAll(selector)].find((el) => text(el) === words)

/** The names in the table's sticky column, in order. */
const rowNames = () =>
  [...document.querySelectorAll('[data-row] a')].map((a) => text(a))

async function type(input: Element | null, value: string) {
  if (!(input instanceof HTMLInputElement)) throw new Error('no input')
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Deals', () => {
  it('the Stage chip narrows the rows: Active by default, then the group picked', async () => {
    await mount('deals')
    await until('the rows', () => rowNames().length > 0)
    expect(rowNames()).toEqual(['Flent seed', 'Zolo A'])
    const chip = document.querySelector('[data-stage-chip]')
    expect(text(chip)).toBe('StageActive2▾')
    await click(chip)
    await until('the stages', () => byText('button', 'Closed1') !== undefined)
    await click(byText('button', 'Closed1'))
    await until('the closed rows', () => rowNames().length === 1)
    expect(rowNames()).toEqual(['Nestaway bridge'])
    expect(text(document.querySelector('[data-stage-chip]'))).toBe(
      'StageClosed1▾',
    )
  })

  it('Table | Board is a Segmented in the bar, and the choice persists', async () => {
    await mount('deals')
    await until(
      'the bar',
      () => byText('[role="radio"]', 'Board') !== undefined,
    )
    await click(byText('[role="radio"]', 'Board'))
    expect(localStorage.getItem('dealos.deals-view')).toBe('board')
    await until(
      'the board',
      () => document.querySelector('[data-board-head]') !== null,
    )
    act(() => root.unmount())
    const host = document.createElement('div')
    document.body.replaceChildren(host)
    root = createRoot(host)
    await mount('deals')
    await until(
      'the board again',
      () => document.querySelector('[data-board-head]') !== null,
    )
    expect(
      byText('[role="radio"]', 'Board')?.getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('the board prints its heads, cards and drop target in its words', async () => {
    localStorage.setItem('dealos.deals-view', 'board')
    await mount('deals')
    await until(
      'the board',
      () => document.querySelector('[data-board-head]') !== null,
    )
    const heads = [...document.querySelectorAll('[data-board-head]')].map((h) =>
      text(h),
    )
    // Active: Screening, then Diligence with its value and median.
    expect(heads).toEqual(['Screening1$350K', 'Diligence1$150KMedian 4d'])
    expect(
      [...document.querySelectorAll('[data-card-lead]')].map((c) => text(c)),
    ).toEqual(['$350K', '$150K · Inbound'])
    expect(
      [...document.querySelectorAll('[data-card-close]')].map((c) => text(c)),
    ).toEqual(['Close 15 Nov · 20d'])
    expect(document.body.textContent).not.toContain('drag to move')
    const column = document.querySelector('[data-board-head]')?.parentElement
    await act(async () => {
      column?.dispatchEvent(
        new Event('dragover', { bubbles: true, cancelable: true }),
      )
    })
    expect(text(document.querySelector('[data-drop-target]'))).toBe(
      'Drop → Screening',
    )
  })
})

describe('Portfolio', () => {
  // The page reads its keyed query, not the match's loader data.
  beforeEach(() => fns.listHoldings.mockResolvedValue(portfolioData()))

  it('no tab bar; the count rides the title; the head is Record a check and ···', async () => {
    await mount('portfolio')
    await until('the head', () => title()?.startsWith('Portfolio') === true)
    expect(document.querySelector('[role="tablist"]')).toBeNull()
    expect(text(document.querySelector('[data-head-count]'))).toBe('2')
    expect(
      [...document.querySelectorAll('[data-head-actions] > *')].map(
        (el) => el.getAttribute('aria-label') ?? text(el),
      ),
    ).toEqual(['Record a check', 'More for Portfolio'])
    // All figures zero: no strip.
    expect(document.querySelector('[data-readouts]')).toBeNull()
  })

  it('Record a check writes an investment against the company it picks', async () => {
    fns.searchEntities.mockResolvedValue([
      { id: id(901), name: 'Flent', kind: 'company' },
    ])
    fns.addInvestment.mockResolvedValue({ ok: true })
    await mount('portfolio')
    await until('the head', () => title()?.startsWith('Portfolio') === true)
    await click(byText('button', 'Record a check'))
    await until(
      'the window',
      () => document.querySelector('[role="dialog"]') !== null,
    )
    await click(document.getElementById('inv-company'))
    await until(
      'the search',
      () => document.querySelector('[aria-label="Search companies"]') !== null,
    )
    await type(document.querySelector('[aria-label="Search companies"]'), 'Fle')
    await until(
      'a match',
      () => document.querySelector('[role="option"]') !== null,
    )
    await act(async () => {
      document
        .querySelector('[role="option"]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await until(
      'the pick',
      () => text(document.getElementById('inv-company')) === 'Flent',
    )
    await type(document.getElementById('inv-date'), '2026-10-20')
    await type(document.getElementById('inv-amount'), '250000')
    const form = document.querySelector('[role="dialog"] form')
    await act(async () => {
      form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fns.addInvestment).toHaveBeenCalledWith({
      data: {
        companyId: id(901),
        date: '2026-10-20',
        amount: 250000,
        currency: 'USD',
        instrument: 'priced',
      },
    })
    // The write refreshes the list it shows under.
    await until(
      'the list refetched',
      () => fns.listHoldings.mock.calls.length === 2,
    )
  })
})

describe('Files', () => {
  it('the kinds are the tabs with their counts, and Unfiled is the first band', async () => {
    await mount('files')
    await until(
      'the tabs',
      () => document.querySelector('[data-tab-bar] [role="tab"]') !== null,
    )
    expect(document.querySelector('[data-head-count]')).toBeNull()
    expect(
      [...document.querySelectorAll('[data-tab-bar] [role="tab"]')].map((t) =>
        text(t),
      ),
    ).toEqual([
      'All48',
      'Decks12',
      'Cap tables',
      'Diligence3',
      'Legal',
      'Articles2',
      'Other31',
    ])
    expect(
      [...document.querySelectorAll('[data-files-band]')].map((b) =>
        b.getAttribute('data-files-band'),
      ),
    ).toEqual(['unfiled', 'last-week'])
    expect(text(document.querySelector('[data-band]'))).toBe('Unfiled3')
    expect(text(document.querySelector('[data-file-guess]'))).toBe(
      'File under Flent↵',
    )
    expect(text(document.querySelector('[data-table-foot]'))).toBe(
      '4 of 48·Load 50 more',
    )
  })

  it('a row under its name: the first line, Reading text, or why it was not read with Read again', async () => {
    fns.reExtractDocument.mockResolvedValue({ queued: true })
    await mount('files')
    await until('the rows', () => document.querySelector('[data-row]') !== null)
    expect(
      [...document.querySelectorAll('[data-file-line]')].map((l) => text(l)),
    ).toEqual([
      'Leases under management',
      'Reading text',
      'Text not read · no text layer and OCR failedRead again',
    ])
    await click(byText('button', 'Read again'))
    expect(fns.reExtractDocument).toHaveBeenCalledWith({
      data: { documentId: id(303) },
    })
  })
})
