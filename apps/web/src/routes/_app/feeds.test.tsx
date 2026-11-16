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
import type { FeedSource } from '#/lib/server-fns'

/**
 * The Feeds page under a memory router whose ids mirror the app's:
 * - the frame: `Headlines` and `Sources n`, the crimson square after the
 *   count while a feed is failing, Headlines' empty line;
 * - Sources: Name, Feed, Spaces by path, Latest as a time today and a day
 *   before, the failing row's since-when and `Fix ›`, the first fetch's
 *   Twinkle, and the row's `···`;
 * - the feed window: found, not a feed, adding, and Fix with its notice;
 * - Remove… saying how many headlines go with the feed;
 * - no feeds at all: one `Feeds +` row.
 */

const fns = vi.hoisted(() => ({
  listFeedSources: vi.fn(),
  listSpaces: vi.fn(),
  previewFeed: vi.fn(),
  addFeed: vi.fn(),
  editFeed: vi.fn(),
  removeFeed: vi.fn(),
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
let page: RouteComponent

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
  const component = (await import('#/routes/_app/feeds')).Route.options
    .component
  if (component === undefined) throw new Error('feeds has no component')
  page = component
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

const NOW = '2026-11-16T12:00:00.000Z'
const AEROSPACE = '00000000-0000-4000-8000-0000000000a1'
const LAUNCH = '00000000-0000-4000-8000-0000000000a2'
const PROPTECH = '00000000-0000-4000-8000-0000000000a3'

const SPACES = [
  { id: AEROSPACE, name: 'Aerospace', parentId: null, companies: 0 },
  { id: LAUNCH, name: 'Launch', parentId: AEROSPACE, companies: 0 },
  { id: PROPTECH, name: 'Proptech', parentId: null, companies: 0 },
]

const at = (day: string, time: string) =>
  new Date(`${day}T${time}`).toISOString()

const source = (n: number, over: Partial<FeedSource>): FeedSource => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Feed ${String(n)}`,
  url: `https://feed${String(n)}.example/feed`,
  siteUrl: null,
  logoSha: null,
  state: 'ok',
  lastFetchedAt: NOW,
  lastSuccessAt: NOW,
  lastError: null,
  spaces: [],
  headlineCount: 10,
  newestAt: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  ...over,
})

const SPACENEWS = source(1, {
  name: 'SpaceNews',
  url: 'https://spacenews.com/feed',
  spaces: [{ id: LAUNCH, name: 'Launch' }],
  newestAt: at('2026-11-16', '10:12'),
})
const ORBIT = source(2, {
  name: 'Orbit Notes',
  url: 'https://orbitnotes.substack.com/feed',
  state: 'failing',
  lastSuccessAt: at('2026-11-13', '09:00'),
  lastError: 'The site answered 404',
  spaces: [{ id: LAUNCH, name: 'Launch' }],
  headlineCount: 214,
})
const TECHCRUNCH = source(3, {
  name: 'TechCrunch',
  url: 'https://techcrunch.com/feed/',
  spaces: [
    { id: LAUNCH, name: 'Launch' },
    { id: PROPTECH, name: 'Proptech' },
  ],
  newestAt: at('2026-11-15', '18:00'),
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  fns.listSpaces.mockResolvedValue(SPACES)
  fns.listFeedSources.mockResolvedValue([SPACENEWS, ORBIT, TECHCRUNCH])
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.replaceChildren()
})

async function mount(search = '') {
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
  const route = createRoute({
    getParentRoute: () => app,
    path: 'feeds',
    component: page,
    loader: async () => ({
      sources: await fns.listFeedSources(),
      spaces: await fns.listSpaces(),
    }),
  })
  const r = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([route])]),
    history: createMemoryHistory({ initialEntries: [`/feeds${search}`] }),
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

async function until(what: string, done: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (done()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  throw new Error(`never ${what}`)
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').trim()

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const button = (words: string | RegExp) =>
  [...document.querySelectorAll('button')].find((b) =>
    typeof words === 'string' ? text(b) === words : words.test(text(b)),
  )

const dialog = () => document.querySelector('[role="dialog"]')

/** A button inside the open window, by its words. */
const inDialog = (words: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => text(b) === words,
  )

async function type(input: Element | null | undefined, value: string) {
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

/** Each row's cells, as text. */
const rows = () =>
  [...document.querySelectorAll('[data-row]')].map((r) =>
    [...r.querySelectorAll('[role="cell"]')].map((c) => text(c)),
  )

async function rowMenu(name: string): Promise<Array<string>> {
  const trigger = document.querySelector(`[aria-label="More for ${name}"]`)
  if (!(trigger instanceof HTMLElement)) throw new Error('no trigger')
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
    text(el),
  )
}

describe('the frame', () => {
  it('opens on Headlines with Sources n and the failing square, and says there are no headlines yet', async () => {
    await mount()
    expect(text(document.querySelector('h1'))).toBe('Feeds')
    expect(button(/^Add feed$/)).toBeDefined()
    const tabs = [...document.querySelectorAll('[role="tab"]')]
    expect(tabs.map((t) => text(t))).toEqual(['Headlines', 'Sources3'])
    expect(tabs.at(0)?.getAttribute('aria-selected')).toBe('true')
    expect(
      tabs.at(1)?.querySelector('[aria-label="A feed is failing"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain('No headlines yet.')
  })

  it('drops the square once no feed is failing', async () => {
    fns.listFeedSources.mockResolvedValue([SPACENEWS, TECHCRUNCH])
    await mount()
    expect(document.querySelector('[data-failing-mark]')).toBeNull()
  })

  it('with no feeds draws one Feeds + row and no tabs', async () => {
    fns.listFeedSources.mockResolvedValue([])
    await mount()
    expect(document.querySelector('[role="tab"]')).toBeNull()
    expect(text(document.querySelector('[data-empty-row]'))).toBe('Feeds+')
  })
})

describe('Sources', () => {
  it('lists every feed by name with its feed URL, spaces by path and its latest', async () => {
    await mount('?tab=sources')
    expect(rows()).toEqual([
      [
        'OOrbit Notes',
        'orbitnotes.substack.com/feed',
        'Aerospace › Launch',
        "Couldn't fetch since 13 NovFix ›",
        '',
      ],
      ['SSpaceNews', 'spacenews.com/feed', 'Aerospace › Launch', '10:12', ''],
      [
        'TTechCrunch',
        'techcrunch.com/feed',
        'Aerospace › Launch, Proptech',
        '15 Nov',
        '',
      ],
    ])
  })

  it('twinkles in Latest while a feed waits on its first fetch', async () => {
    fns.listFeedSources.mockResolvedValue([
      source(4, { name: 'Inc42', state: 'new', lastSuccessAt: null }),
    ])
    await mount('?tab=sources')
    const latest = document.querySelector('[data-latest="new"]')
    expect(text(latest)).toBe('Fetching')
    expect(latest?.querySelector('[data-twinkle]')).not.toBeNull()
  })

  it('ends each row on a ··· of Edit…, Copy feed URL, then Remove…', async () => {
    await mount('?tab=sources')
    expect(await rowMenu('SpaceNews')).toEqual([
      'Edit…',
      'Copy feed URL',
      'Remove…',
    ])
  })

  it('Fix › opens the feed’s window with the reason it fails', async () => {
    await mount('?tab=sources')
    await click(button('Fix ›'))
    expect(text(dialog()?.querySelector('h2'))).toBe('Orbit Notes')
    expect(text(dialog()?.querySelector('[data-feed-notice]'))).toBe(
      "Couldn't fetch since 13 Nov. The site answered 404, so the feed has likely moved.",
    )
    const inputs = [...(dialog()?.querySelectorAll('input') ?? [])]
    expect(inputs.map((i) => i.value)).toEqual([
      'https://orbitnotes.substack.com/feed',
      'Orbit Notes',
    ])
    expect(
      dialog()?.querySelector('[data-spaces-field]')?.textContent,
    ).toContain('Aerospace › Launch')
    expect(button('Remove…')).toBeDefined()
    expect(button('Save')?.disabled).toBe(true)

    fns.editFeed.mockResolvedValue({ ...ORBIT, state: 'new' })
    await type(inputs.at(0), 'https://orbitnotes.com/feed')
    await click(button('Save'))
    expect(fns.editFeed).toHaveBeenCalledWith({
      data: { id: ORBIT.id, address: 'https://orbitnotes.com/feed' },
    })
    await until('the window closes', () => dialog() === null)
  })

  it('Remove… says how many headlines go with the feed, then removes it', async () => {
    fns.removeFeed.mockResolvedValue({ removed: true })
    await mount('?tab=sources')
    await click(button('Fix ›'))
    await click(button('Remove…'))
    await until('the confirm opens', () =>
      text(dialog()?.querySelector('h2')).startsWith('Remove'),
    )
    expect(text(dialog()?.querySelector('h2'))).toBe('Remove Orbit Notes?')
    expect(dialog()?.textContent).toContain('Its 214 headlines go with it.')
    await click(button('Remove'))
    await until(
      'the feed is removed',
      () => fns.removeFeed.mock.calls.length > 0,
    )
    expect(fns.removeFeed).toHaveBeenCalledWith({ data: { id: ORBIT.id } })
  })
})

describe('Add feed', () => {
  const field = () => dialog()?.querySelector('input')

  it('shows what the address resolves to, then adds with its spaces and lands on Sources', async () => {
    fns.previewFeed.mockResolvedValue({
      _tag: 'Found',
      name: 'SpaceNews',
      url: 'https://spacenews.com/feed',
      newestAt: at('2026-11-16', '10:00'),
      newestSinceMs: 2 * 60 * 60 * 1000,
    })
    let land: (v: unknown) => void = () => undefined
    fns.addFeed.mockReturnValue(
      new Promise((resolve) => {
        land = resolve
      }),
    )
    await mount()
    await click(button(/^Add feed$/))
    expect(text(dialog()?.querySelector('h2'))).toBe('Add feed')
    expect(
      [...(dialog()?.querySelectorAll('label') ?? [])].map((l) => text(l)),
    ).toEqual(['Feed or site URL', 'Spaces'])

    await type(field(), 'spacenews.com')
    await until('the feed is found', () =>
      Boolean(dialog()?.querySelector('[data-feed-lookup="found"]')),
    )
    expect(text(dialog()?.querySelector('[data-feed-lookup="found"]'))).toBe(
      'SSpaceNewsspacenews.com/feed · newest 2h ago',
    )
    expect(fns.previewFeed).toHaveBeenCalledWith({
      data: { address: 'spacenews.com' },
    })

    await click(dialog()?.querySelector('[data-spaces-field] button'))
    const option = [...document.querySelectorAll('[cmdk-item]')].find(
      (el) => text(el) === 'Aerospace › Launch',
    )
    await click(option)

    await click(inDialog('Add feed'))
    // Working: the twinkle and the present tense, no ellipsis.
    const adding = button('Adding')
    expect(adding?.querySelector('[data-twinkle]')).not.toBeNull()
    expect(adding?.disabled).toBe(true)
    expect(fns.addFeed).toHaveBeenCalledWith({
      data: { address: 'spacenews.com', spaceIds: [LAUNCH] },
    })

    fns.listFeedSources.mockResolvedValue([
      source(5, { name: 'SpaceNews', state: 'new' }),
    ])
    await act(async () => {
      land({ source: SPACENEWS, newest: null })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await until('the window closes', () => dialog() === null)
    await until('Sources opens', () =>
      Boolean(document.querySelector('[data-latest="new"]')),
    )
  })

  it('says a page has no feed in crimson and keeps Add off', async () => {
    fns.previewFeed.mockResolvedValue({
      _tag: 'Refused',
      message:
        "That page has no feed. Paste the site's address or its RSS link.",
    })
    await mount()
    await click(button(/^Add feed$/))
    await type(field(), 'the-ken.com/story/co-living-software')
    await until('the refusal shows', () =>
      Boolean(dialog()?.querySelector('[role="alert"]')),
    )
    const alert = dialog()?.querySelector('[role="alert"]')
    expect(text(alert)).toBe(
      "That page has no feed. Paste the site's address or its RSS link.",
    )
    expect(alert?.className).toContain('text-destructive')
    expect(inDialog('Add feed')?.disabled).toBe(true)
  })
})
