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
import { readDock } from '#/lib/ask/dock-store'
import type { FeedSource, Headline, HeadlinePage } from '#/lib/server-fns'

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
  listHeadlines: vi.fn(),
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

const FINTECH = '00000000-0000-4000-8000-0000000000a4'

const SPACES = [
  { id: AEROSPACE, name: 'Aerospace', parentId: null, companies: 0 },
  { id: LAUNCH, name: 'Launch', parentId: AEROSPACE, companies: 0 },
  { id: PROPTECH, name: 'Proptech', parentId: null, companies: 0 },
  { id: FINTECH, name: 'Fintech', parentId: null, companies: 0 },
]

const at = (day: string, time: string) =>
  new Date(`${day}T${time}`).toISOString()

const source = (n: number, over: Partial<FeedSource>): FeedSource => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Feed ${String(n)}`,
  url: `https://feed${String(n)}.example/feed`,
  siteUrl: null,
  logoSha: null,
  logoUrl: null,
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

const story = (n: number, over: Partial<Headline>): Headline => ({
  id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
  feedId: SPACENEWS.id,
  feedName: 'SpaceNews',
  siteUrl: 'https://spacenews.com/',
  logoSha: null,
  logoUrl: null,
  title: `Story ${String(n)}`,
  url: `https://spacenews.com/story-${String(n)}`,
  summary: null,
  publishedAt: at('2026-11-16', '10:12'),
  imageSha: null,
  photoUrl: null,
  photoPending: false,
  ...over,
})

const SKYROOT = story(1, {
  title: 'Skyroot static-fires the Vikram-1 third stage',
  summary:
    'Skyroot Aerospace ran the third stage through a full burn.\n\nThe stage reached its rated thrust with no anomalies.',
  imageSha: 'p1',
  photoUrl: 'http://localhost/api/blob/p1?sig=x',
})
const NOBROKER = story(2, {
  feedId: TECHCRUNCH.id,
  feedName: 'TechCrunch',
  siteUrl: 'https://techcrunch.com/',
  title: 'NoBroker trims listing fees for Pune landlords',
  url: 'https://techcrunch.com/nobroker',
  publishedAt: at('2026-11-16', '08:55'),
})
const LICENCES = story(3, {
  title: 'IN-SPACe clears three private launch licences',
  summary: 'Skyroot, Agnikul and a third operator.',
  publishedAt: at('2026-11-15', '18:20'),
  photoPending: true,
})
const DIGANTARA = story(4, {
  feedId: TECHCRUNCH.id,
  feedName: 'TechCrunch',
  title: 'Digantara raises $18M for space situational awareness',
  url: 'https://techcrunch.com/digantara',
  summary: 'Led by Peak XV.',
  publishedAt: at('2026-11-13', '15:05'),
})
const STORIES = [SKYROOT, NOBROKER, LICENCES, DIGANTARA]

const pageOf = (
  headlines: Array<Headline>,
  over: Partial<HeadlinePage> = {},
): HeadlinePage => ({
  headlines,
  nextCursor: null,
  total: headlines.length,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  fns.listSpaces.mockResolvedValue(SPACES)
  fns.listFeedSources.mockResolvedValue([SPACENEWS, ORBIT, TECHCRUNCH])
  fns.listHeadlines.mockResolvedValue(pageOf([]))
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
    // Page one is left to the tab, as after a failed read in the loader:
    // the tab's own query is what these tests drive.
    loader: async () => ({
      sources: await fns.listFeedSources(),
      spaces: await fns.listSpaces(),
      headlines: { space: null, page: null },
    }),
  })
  const r = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([route])]),
    history: createMemoryHistory({ initialEntries: [`/feeds${search}`] }),
  })
  await act(async () => {
    await r.load()
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ClockProvider now={NOW}>
          <RouterProvider router={r} />
        </ClockProvider>
      </QueryClientProvider>,
    )
  })
  return r
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

/** Each row's cells, as text: the name that heads it, then its values. */
const rows = () =>
  [...document.querySelectorAll('[data-row]')].map((r) =>
    [...r.querySelectorAll('[role="rowheader"], [role="cell"]')].map((c) =>
      text(c),
    ),
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
    fns.listHeadlines.mockResolvedValue(pageOf([]))
    await mount()
    expect(text(document.querySelector('h1'))).toBe('Feeds')
    expect(button(/^Add feed$/)).toBeDefined()
    const tabs = [...document.querySelectorAll('[role="tab"]')]
    expect(tabs.map((t) => text(t))).toEqual(['Headlines', 'Sources3'])
    expect(tabs.at(0)?.getAttribute('aria-selected')).toBe('true')
    expect(
      tabs.at(1)?.querySelector('[aria-label="A feed is failing"]'),
    ).not.toBeNull()
    await until('the list answers', () =>
      Boolean(document.querySelector('[data-list-state="none"]')),
    )
    expect(document.body.textContent).toContain('No headlines yet.')
  })

  it('drops the square once no feed is failing', async () => {
    fns.listFeedSources.mockResolvedValue([SPACENEWS, TECHCRUNCH])
    await mount()
    expect(document.querySelector('[data-failing-mark]')).toBeNull()
  })

  it('with no feeds says so with a way to add one, and draws no tabs', async () => {
    fns.listFeedSources.mockResolvedValue([])
    await mount()
    expect(document.querySelector('[role="tab"]')).toBeNull()
    const row = document.querySelector('[data-list-state="no-feeds"]')
    expect(text(row)).toBe('No feeds yet.Add a feed')
    await click(row?.querySelector('button'))
    expect(text(dialog()?.querySelector('h2'))).toBe('Add feed')
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

describe('Headlines', () => {
  const stories = () =>
    [...document.querySelectorAll('[data-story]')].map((el) => ({
      id: el.getAttribute('data-story'),
      selected: el.getAttribute('aria-current') === 'true',
      photo: el.querySelector('[data-story-photo]') !== null,
    }))
  const selectedTitle = () =>
    text(
      document.querySelector(
        '[data-story][aria-current="true"] .headline-serif',
      ),
    )
  const reader = () => document.querySelector('[data-reader]')
  const key = async (k: string, target: Element = document.body) => {
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: k,
          bubbles: true,
          cancelable: true,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  const listed = () => until('the stories draw', () => stories().length > 0)

  it('draws stories under day bands beside the reader, the newest selected', async () => {
    fns.listHeadlines.mockResolvedValue(
      pageOf(STORIES, { total: 312, nextCursor: 'next' }),
    )
    await mount()
    await listed()
    expect(fns.listHeadlines).toHaveBeenCalledWith({ data: { limit: 50 } })
    expect(
      [...document.querySelectorAll('[data-story-list] [data-band]')].map((b) =>
        text(b),
      ),
    ).toEqual(['Today', 'Yesterday', 'Fri 13 Nov'])
    // A photo only where the story has one stored; none while it fetches.
    expect(stories()).toEqual([
      { id: SKYROOT.id, selected: true, photo: true },
      { id: NOBROKER.id, selected: false, photo: false },
      { id: LICENCES.id, selected: false, photo: false },
      { id: DIGANTARA.id, selected: false, photo: false },
    ])
    const first = document.querySelector(`[data-story="${SKYROOT.id}"]`)
    expect(text(first)).toBe(
      'SSpaceNews10:12Skyroot static-fires the Vikram-1 third stageSkyroot Aerospace ran the third stage through a full burn. The stage reached its rated thrust with no anomalies.',
    )
    expect(first?.getAttribute('href')).toBe(SKYROOT.url)
    expect(first?.getAttribute('target')).toBe('_blank')

    // The reader: bar, headline, photo, prose, and the hand-off with spaces.
    expect(text(reader()?.querySelector('h2'))).toBe(SKYROOT.title)
    expect(text(reader()?.querySelector('time'))).toBe('16 Nov · 10:12')
    expect(
      reader()?.querySelector('[data-reader-photo]')?.getAttribute('src'),
    ).toBe(SKYROOT.photoUrl)
    expect(
      [...(reader()?.querySelectorAll('article p') ?? [])].map((p) => text(p)),
    ).toEqual([
      'Skyroot Aerospace ran the third stage through a full burn.',
      'The stage reached its rated thrust with no anomalies.',
    ])
    const out = [...(reader()?.querySelectorAll('a') ?? [])].map((a) => [
      text(a),
      a.getAttribute('href'),
    ])
    expect(out).toEqual([
      ['Open article ↗', SKYROOT.url],
      ['Continue on spacenews.com ↗', SKYROOT.url],
    ])
    expect(reader()?.querySelector('footer')?.textContent).toContain(
      'Aerospace › Launch',
    )

    // The foot counts the loaded of the total and loads the next 50.
    const foot = document.querySelector('[data-story-list] [data-table-foot]')
    expect(text(foot)).toBe('4 of 312·Load 50 more')
    fns.listHeadlines.mockResolvedValue(
      pageOf([story(5, { publishedAt: at('2026-11-12', '09:00') })], {
        total: 312,
      }),
    )
    await click(button('Load 50 more'))
    await until('the next page lands', () => stories().length === 5)
    expect(fns.listHeadlines).toHaveBeenLastCalledWith({
      data: { limit: 50, cursor: 'next' },
    })
    expect(selectedTitle()).toBe(SKYROOT.title)
  })

  it('J and K walk the list, O and Enter open the article, a click selects', async () => {
    const open = vi.spyOn(win, 'open').mockReturnValue(null)
    // Wide: the reader is beside the list.
    const always = win.matchMedia('(min-width: 1px)')
    const wide = vi.spyOn(win, 'matchMedia').mockReturnValue(always)
    fns.listHeadlines.mockResolvedValue(pageOf(STORIES))
    await mount()
    await listed()
    await key('j')
    await key('j')
    expect(selectedTitle()).toBe(LICENCES.title)
    expect(text(reader()?.querySelector('h2'))).toBe(LICENCES.title)
    // A photo the worker has yet to store: a bone plate with the Twinkle.
    expect(
      reader()
        ?.querySelector('[data-reader-photo="pending"]')
        ?.querySelector('[data-twinkle]'),
    ).not.toBeNull()
    await key('k')
    expect(selectedTitle()).toBe(NOBROKER.title)
    // A feed with no text of its own says so, and the bar still opens it.
    expect(text(reader()?.querySelector('[data-headlines-only]'))).toBe(
      'TechCrunch sends headlines only. The story is on its site.',
    )
    await key('j')
    await key('j')
    await key('j')
    expect(selectedTitle()).toBe(DIGANTARA.title)

    await key('o')
    expect(open).toHaveBeenLastCalledWith(
      DIGANTARA.url,
      '_blank',
      'noopener,noreferrer',
    )
    await key('Enter')
    expect(open).toHaveBeenCalledTimes(2)

    // A wide click selects. (Whether the link also follows is the
    // browser's to say; happy-dom follows an anchor whatever the handler.)
    await click(document.querySelector(`[data-story="${SKYROOT.id}"]`))
    expect(selectedTitle()).toBe(SKYROOT.title)
    open.mockClear()

    // Not while typing, and not inside a window.
    const input = document.createElement('input')
    document.body.append(input)
    await key('j', input)
    await key('o', input)
    expect(selectedTitle()).toBe(SKYROOT.title)
    expect(open).not.toHaveBeenCalled()
    await click(button(/^Add feed$/))
    await key('j', dialog() ?? document.body)
    expect(selectedTitle()).toBe(SKYROOT.title)
    open.mockRestore()
    wide.mockRestore()
  })

  it('narrow, a tap is the article link and there is no reader', async () => {
    const open = vi.spyOn(win, 'open').mockReturnValue(null)
    const never = win.matchMedia('(min-width: 100000px)')
    expect(never.matches).toBe(false)
    const narrow = vi.spyOn(win, 'matchMedia').mockReturnValue(never)
    fns.listHeadlines.mockResolvedValue(pageOf(STORIES))
    await mount()
    await listed()
    const tapped = document.querySelector(`[data-story="${NOBROKER.id}"]`)
    // The link is left to open the article: the selection does not move.
    await click(tapped)
    expect(tapped?.getAttribute('href')).toBe(NOBROKER.url)
    expect(selectedTitle()).toBe(SKYROOT.title)
    // The reader's pane is drawn only from `md` up.
    expect(reader()?.parentElement?.className).toContain('hidden')
    expect(reader()?.parentElement?.className).toContain('md:flex')
    narrow.mockRestore()
    open.mockRestore()
  })

  it('Ask about this opens Ask with the headline and its link; Copy link is there', async () => {
    fns.listHeadlines.mockResolvedValue(pageOf(STORIES))
    await mount()
    await listed()
    const items = await rowMenu(SKYROOT.title)
    expect(items).toEqual(['Copy link', 'Ask about this'])
    const ask = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => text(el) === 'Ask about this',
    )
    await click(ask)
    await until('Ask opens', () => readDock().open)
    expect(readDock().draft).toBe(`${SKYROOT.title}\n${SKYROOT.url ?? ''}\n\n`)
  })

  it('narrows to a space, keeps it in the URL, and keeps the story while it is listed', async () => {
    fns.listHeadlines.mockResolvedValue(pageOf(STORIES))
    const r = await mount()
    await listed()
    await click(document.querySelector(`[data-story="${DIGANTARA.id}"]`))
    expect(selectedTitle()).toBe(DIGANTARA.title)

    await click(document.querySelector('[data-space-filter] button'))
    const options = [...document.querySelectorAll('[cmdk-item]')].map((el) =>
      text(el),
    )
    expect(options).toEqual(['All spaces', 'Aerospace › Launch', 'Proptech'])
    fns.listHeadlines.mockResolvedValue(pageOf([NOBROKER, DIGANTARA]))
    await click(
      [...document.querySelectorAll('[cmdk-item]')].find(
        (el) => text(el) === 'Proptech',
      ),
    )
    await until('the narrowed list lands', () => stories().length === 2)
    expect(fns.listHeadlines).toHaveBeenLastCalledWith({
      data: { limit: 50, spaceId: PROPTECH },
    })
    expect(r.state.location.search).toMatchObject({ space: PROPTECH })
    expect(text(document.querySelector('[data-space-filter]'))).toBe('Proptech')
    expect(selectedTitle()).toBe(DIGANTARA.title)
  })

  it('a space no feed is tagged to says so, with the way back to all spaces', async () => {
    const r = await mount(`?space=${FINTECH}`)
    await until('the list answers', () =>
      Boolean(document.querySelector('[data-list-state="no-feed"]')),
    )
    const row = document.querySelector('[data-list-state="no-feed"]')
    expect(text(row)).toBe('No feed is tagged to Fintech.All spaces')
    expect(text(document.querySelector('[data-space-filter]'))).toBe('Fintech')
    await click(row?.querySelector('button'))
    await until(
      'the filter clears',
      () => !('space' in r.state.location.search),
    )
  })

  it('twinkles while loading, then says it could not load and retries', async () => {
    let fail: (e: Error) => void = () => undefined
    fns.listHeadlines.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject
      }),
    )
    await mount()
    const loading = document.querySelector('[data-list-state="loading"]')
    expect(text(loading)).toBe('Loading headlines')
    expect(loading?.querySelector('[data-twinkle]')).not.toBeNull()

    await act(async () => {
      fail(new Error('down'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await until('the error shows', () =>
      Boolean(document.querySelector('[data-list-state="error"]')),
    )
    expect(text(document.querySelector('[data-list-state="error"]'))).toBe(
      "Couldn't load headlines. The database did not answer.Retry",
    )
    fns.listHeadlines.mockResolvedValue(pageOf(STORIES))
    await click(button('Retry'))
    await listed()
  })
})
