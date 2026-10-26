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
 * The three object lists' heads, walked under a memory router whose ids
 * mirror the app's (`_app` → `companies`, `people`, `o/$objectSlug`):
 * - the head is `[New x] [···]` with no count beside the title, and Import…
 *   lives in the `···` with Enrich…;
 * - a custom object's `···` would hold Import… alone, so it is that verb as
 *   the outline secondary, left of the primary;
 * - first run (the list holds nothing): the primary hides and the body is
 *   one `EmptyRow` that creates.
 * The loaders hand each page fixture data; the list queries' refetch is a
 * spy answering the same page.
 */

const page = (rows: Array<object>) => ({
  rows,
  nextCursor: null,
  total: rows.length,
  refNames: {},
})

const reads = vi.hoisted(() => {
  const rows: Array<object> = []
  return { rows }
})

vi.mock('#/lib/server-fns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listCompaniesTable: vi.fn(async () => page(reads.rows)),
  listPeopleTable: vi.fn(async () => page(reads.rows)),
  listObjectRecords: vi.fn(async () => page(reads.rows)),
  countViews: vi.fn(async () => ({})),
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
    companies: await import('#/routes/_app/companies'),
    people: await import('#/routes/_app/people'),
    'o/$objectSlug': await import('#/routes/_app/o.$objectSlug'),
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

const ROW = {
  id: '00000000-0000-4000-8000-000000000101',
  name: 'Flent',
  values: {},
  spaces: [],
  stats: {},
  picture: null,
  createdAt: '2026-10-01T09:00:00.000Z',
}

/** What each loader hands its page; `rows` is the list's whole content. */
function loaderData(path: string, rows: Array<object>) {
  const common = {
    conditions: [],
    sort: null,
    initial: page(rows),
    allTotal: rows.length,
    registry: [],
    inverses: [],
    views: [],
    counts: {},
    me: { id: 'u-admin', role: 'admin' },
  }
  if (path === 'companies') return { ...common, objectId: OBJECT_ID }
  if (path === 'people')
    return { ...common, objectId: OBJECT_ID, companies: [] }
  return {
    ...common,
    object: {
      id: OBJECT_ID,
      slug: 'funds',
      singular: 'Fund',
      plural: 'Funds',
      icon: null,
      isSystem: false,
      archived: false,
    },
  }
}

async function mount(path: string, rows: Array<object>) {
  reads.rows = rows
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
  if (component === undefined) throw new Error(`no page ${path}`)
  const route = createRoute({
    getParentRoute: () => app,
    path,
    component,
    loader: () => loaderData(path, rows),
  })
  const r = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([route])]),
    history: createMemoryHistory({
      initialEntries: [`/${path.replace('$objectSlug', 'funds')}`],
    }),
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

/** The head's controls in order, each by its text or else its name. */
const head = () =>
  Array.from(document.querySelectorAll('[data-head-actions] > *')).map(
    (el) => el.getAttribute('aria-label') ?? el.textContent.trim(),
  )

async function menuItems(label: string): Promise<Array<string>> {
  const trigger = document.querySelector(`button[aria-label="${label}"]`)
  if (!(trigger instanceof HTMLElement)) throw new Error(`no ${label}`)
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await until(
    'the menu',
    () => document.querySelector('[role="menu"]') !== null,
  )
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) =>
    el.textContent.trim(),
  )
}

const title = () => document.querySelector('h1')?.textContent

describe('a list head', () => {
  it.each([
    ['companies', 'Companies', 'New company'],
    ['people', 'People', 'New person'],
  ])(
    '%s: [New x] [···], no count by the title, Import… inside the ···',
    async (path, plural, create) => {
      await mount(path, [ROW])
      await until('the head', () => title() === plural)
      expect(document.querySelector('[data-head-count]')).toBeNull()
      expect(head()).toEqual([create, `More for ${plural}`])
      expect(await menuItems(`More for ${plural}`)).toEqual([
        'Import…',
        'Enrich…',
      ])
    },
  )

  it('a custom object: its one rare verb is the outline secondary, left of New', async () => {
    await mount('o/$objectSlug', [ROW])
    await until('the head', () => title() === 'Funds')
    expect(document.querySelector('[data-head-count]')).toBeNull()
    expect(head()).toEqual(['Import…', 'New fund'])
  })
})

describe('first run', () => {
  it.each([
    ['companies', 'Companies', 'New company'],
    ['people', 'People', 'New person'],
    ['o/$objectSlug', 'Funds', 'New fund'],
  ])(
    '%s: the primary hides and one row creates',
    async (path, plural, create) => {
      await mount(path, [])
      await until('the head', () => title() === plural)
      expect(head()).not.toContain(create)
      expect(document.querySelector('[data-view-bar]')).toBeNull()
      const row = document.querySelector('[data-empty-row]')
      if (!(row instanceof HTMLElement)) throw new Error('no first-run row')
      expect(row.textContent).toBe(`${plural}+`)
      await act(async () => {
        row.click()
      })
      await until('the create window', () =>
        Array.from(document.querySelectorAll('[role="dialog"] h2')).some(
          (h) => h.textContent === create,
        ),
      )
    },
  )
})
