import { Window } from 'happy-dom'
import { act, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { z } from 'zod'
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

import type { ViewRow } from '@spaces/core/writes/views/store'
import { useViewState } from './views/use-view-state'
import type * as SidebarModule from './app-sidebar'
import type * as PrefsModule from '#/lib/chassis-prefs'
import type * as RouterModule from '@tanstack/react-router'

/**
 * The chassis, mounted under a memory router: the folding groups, the starred
 * spaces under Spaces, the pinned views under their object, the foot (Ask
 * above the account row), the two menus, the phone drawer's missing keys and
 * the current row's tab.
 *
 * The DOM is a happy-dom `Window` on this file's globals, so the per-file
 * database setup stays on node.
 */

type PinnedAnswer = {
  id: string
  name: string
  objectSlug: string
  visibility: 'shared' | 'private'
}

/** What the server answers for pinned ids: these, when asked about. */
const served = vi.hoisted(() => {
  const views: Array<PinnedAnswer> = []
  const members: Array<{ id: string; banned: boolean | null }> = []
  return { views, drafts: 0, members }
})

vi.mock('#/lib/server-fns', () => ({
  listPinnedViews: vi.fn(async ({ data }: { data: { ids: Array<string> } }) =>
    served.views.filter((v) => data.ids.includes(v.id)),
  ),
  countEmailDrafts: vi.fn(async () => served.drafts),
  listMembers: vi.fn(async () => served.members),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let sidebar: typeof SidebarModule
let prefs: typeof PrefsModule
let router: typeof RouterModule

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('localStorage', win.localStorage)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('Element', win.Element)
  vi.stubGlobal('Node', win.Node)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  // The account menu's Radix content measures and observes when it opens.
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  vi.stubGlobal('UIEvent', win.UIEvent)
  vi.stubGlobal('FocusEvent', win.FocusEvent)
  vi.stubGlobal('PointerEvent', win.PointerEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('MutationObserver', win.MutationObserver)
  vi.stubGlobal('ResizeObserver', win.ResizeObserver)
  vi.stubGlobal('DOMRect', win.DOMRect)
  vi.stubGlobal('requestAnimationFrame', win.requestAnimationFrame.bind(win))
  vi.stubGlobal('cancelAnimationFrame', win.cancelAnimationFrame.bind(win))
  // The router restores scroll after a navigation.
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // react-dom decides whether it has a DOM when it loads, so after the stubs.
  ;({ createRoot } = await import('react-dom/client'))
  sidebar = await import('./app-sidebar')
  prefs = await import('#/lib/chassis-prefs')
  router = await import('@tanstack/react-router')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  localStorage.clear()
  served.views.length = 0
  served.drafts = 0
  served.members.length = 0
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const user = { name: 'Anish Badri', email: 'anish@fund.example' }

type HeadProps = {
  workspaceName?: string
  workspaceLogo?: string | null
  collapsed?: boolean
  tasksDue?: number
  tasksOverdue?: number
  isAdmin?: boolean
  drawer?: boolean
  onOpenKeyboard?: () => void
}

async function mount(
  path: string,
  objects: Array<{ slug: string; plural: string; icon: string | null }> = [],
  head: HeadProps = {},
) {
  const { AppSidebar } = sidebar
  const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
    router
  const rootRoute = createRootRoute({
    component: () => (
      <AppSidebar
        user={user}
        objects={objects}
        onOpenCommand={() => {}}
        {...head}
      />
    ),
  })
  const r = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await act(async () => {
    await r.load()
    root.render(
      <QueryClientProvider client={queryClient()}>
        <RouterProvider router={r} />
      </QueryClientProvider>,
    )
  })
  await settle()
}

const queryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

/** Lets a query resolve and the render it causes land. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const nav = () => {
  const el = document.querySelector('nav[aria-label="Primary"]')
  if (!el) throw new Error('no primary nav')
  return el
}

/** Visible row labels in the nav, in order — hidden groups excluded. */
const rows = () =>
  Array.from(nav().querySelectorAll('a'))
    .filter((a) => a.closest('[hidden]') === null)
    .map((a) => a.textContent.replace(/G [A-Z,]$/, '').trim())

const button = (name: RegExp) => {
  const hit = Array.from(document.querySelectorAll('button')).find((b) =>
    name.test(b.getAttribute('aria-label') ?? b.textContent),
  )
  if (!hit) throw new Error(`no button ${name}`)
  return hit
}

const click = (el: { click: () => void }) => act(() => el.click())

/** A fresh root for a second mount inside one test. */
function remount() {
  act(() => root.unmount())
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
}

/** Opens a Radix menu from the keyboard, then lets its queries land. */
async function openMenu(trigger: Element) {
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await settle()
  await settle()
}

const menuItems = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) =>
    el.textContent.trim(),
  )

const one = (selector: string) => {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}

describe('the chassis', () => {
  it('draws Work, then Library, Objects and Capital', async () => {
    await mount('/today')
    expect(rows()).toEqual([
      'Today',
      'Tasks',
      'Spaces',
      'Notes',
      'Meetings',
      'Files',
      'Companies',
      'People',
      'Deals',
      'Portfolio',
      'Mandate',
    ])
  })

  it('prints Tasks’ due count in ink, destructive only when a task is overdue, else its chord', async () => {
    const tasksLane = () => {
      const lane = nav().querySelector('a[href="/tasks"]')?.lastElementChild
      if (!lane) throw new Error('no tasks lane')
      return lane
    }
    await mount('/today', [], { tasksDue: 3 })
    expect(tasksLane().textContent).toBe('3 due')
    expect(tasksLane().className).toContain('text-foreground')
    expect(tasksLane().className).not.toContain('text-destructive')

    remount()
    await mount('/today', [], { tasksDue: 3, tasksOverdue: 1 })
    expect(tasksLane().textContent).toBe('3 due')
    expect(tasksLane().className).toContain('text-destructive')

    remount()
    await mount('/today', [], { tasksDue: 0 })
    expect(tasksLane().textContent).toBe('G K')
    expect(tasksLane().className).toContain('text-graphite')
  })

  it('folds a group to its heading and count, and remembers it', async () => {
    await mount('/today')
    click(button(/^Library/))
    click(button(/^Capital/))
    expect(rows()).toEqual(
      ['Today', 'Tasks', 'Spaces'].concat(['Companies', 'People', 'Deals']),
    )
    expect(button(/^Library/).textContent).toContain('▸ 3')
    expect(button(/^Library/).getAttribute('aria-expanded')).toBe('false')
    expect(button(/^Capital/).textContent).toContain('▸ 2')

    // A remount reads the fold back from the browser.
    act(() => root.unmount())
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await mount('/today')
    expect(rows()).not.toContain('Files')
    expect(rows()).not.toContain('Mandate')
    click(button(/^Library/))
    expect(rows()).toContain('Files')
  })

  it('folds the custom objects past the third into ▸ n more, in place', async () => {
    const objects = ['funds', 'lps', 'theses', 'brokers'].map((slug) => ({
      slug,
      plural: slug.toUpperCase(),
      icon: null,
    }))
    await mount('/today', objects)
    expect(rows()).toContain('THESES')
    expect(rows()).not.toContain('BROKERS')
    const more = button(/Show 1 more objects/)
    expect(more.textContent).toBe('▸ 1 more')
    click(more)
    expect(rows()).toContain('BROKERS')
    // The folded count counts every row of the group, customs included.
    click(button(/^Objects/))
    expect(button(/^Objects/).textContent).toContain('▸ 7')
  })

  it('lists five starred spaces in star order and folds the sixth', async () => {
    for (const n of [1, 2, 3, 4, 5, 6])
      prefs.toggleStarredSpace({ id: `s${n}`, name: `Space ${n}` })
    await mount('/today')
    const after = rows().slice(rows().indexOf('Spaces') + 1, -8)
    expect(after).toEqual([
      'Space 1',
      'Space 2',
      'Space 3',
      'Space 4',
      'Space 5',
    ])
    click(button(/Show 1 more starred spaces/))
    expect(rows()).toContain('Space 6')
  })

  it('drops an unstarred space at once', async () => {
    prefs.toggleStarredSpace({ id: 'p', name: 'Property ops' })
    await mount('/today')
    expect(rows()).toContain('Property ops')
    act(() => prefs.toggleStarredSpace({ id: 'p', name: 'Property ops' }))
    expect(rows()).not.toContain('Property ops')
  })

  it('puts Settings alone on the account row, and Upload nowhere', async () => {
    await mount('/today')
    const account = one('[data-account-row]')
    const settings = account.querySelector('a[aria-label="Settings"]')
    expect(settings?.getAttribute('href')).toBe('/settings')
    expect(account.querySelectorAll('a, button')).toHaveLength(2)
    expect(nav().querySelector('a[href="/settings"]')).toBeNull()
    expect(document.querySelector('[aria-label="Upload"]')).toBeNull()
  })

  it('draws Ask as a foot row above the account row, with ⌘J in its lane', async () => {
    await mount('/today')
    expect(nav().querySelector('a[href="/ask"]')).toBeNull()
    const ask = one('[data-ask-row]')
    expect(ask.querySelector('a')?.getAttribute('href')).toBe('/ask')
    expect(ask.textContent).toMatch(/^Ask(⌘J|Ctrl J)$/)
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(follows(nav(), ask)).toBe(true)
    expect(follows(ask, one('[data-account-row]'))).toBe(true)
  })

  it('keeps Ask at the foot when collapsed, above Settings and the account', async () => {
    await mount('/today', [], { collapsed: true })
    expect(nav().querySelector('a[href="/ask"]')).toBeNull()
    const ask = one('[data-ask-row]')
    expect(ask.getAttribute('href')).toBe('/ask')
    const settings = one('a[aria-label="Settings"]')
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(follows(ask, settings)).toBe(true)
    expect(follows(settings, one('[data-account-row]'))).toBe(true)
    expect(document.querySelector('[aria-label="Upload"]')).toBeNull()
  })

  it('prints no key hints in the phone drawer, but keeps Tasks’ count', async () => {
    await mount('/today', [], { drawer: true, tasksDue: 8 })
    const lanes = Array.from(document.querySelectorAll('[data-lane]')).map(
      (el) => el.textContent,
    )
    expect(lanes).toEqual(['8 due'])
    expect(button(/^Search or jump to/).querySelector('kbd')).toBeNull()
    expect(one('[data-ask-row]').textContent).toBe('Ask')
    // The drawer has no head: the top bar carries the wordmark.
    expect(document.querySelector('[data-workspace-head]')).toBeNull()
  })

  it('lists the account menu in words: Drafts, Keyboard, Sign out', async () => {
    await mount('/today', [], { onOpenKeyboard: () => {} })
    await openMenu(button(/Anish Badri/))
    expect(document.body.textContent).toContain(
      'Signed in as anish@fund.example',
    )
    expect(menuItems()).toEqual(['Drafts0', 'Keyboard?', 'Sign out'])
    const menu = one('[role="menu"]')
    expect(menu.querySelector('svg')).toBeNull()
  })

  it('counts the drafts in the account menu, read again each time it opens', async () => {
    served.drafts = 1
    await mount('/today')
    const trigger = button(/Anish Badri/)
    const count = () =>
      document.querySelector('[data-drafts-count]')?.textContent ?? null
    await openMenu(trigger)
    expect(count()).toBe('1')
    // A draft trashed elsewhere: the next opening reads the new number.
    served.drafts = 0
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    await settle()
    await openMenu(trigger)
    expect(count()).toBe('0')
  })

  it('marks the current row by colour only — the same box as every row', async () => {
    await mount('/files')
    const links = Array.from(nav().querySelectorAll('a'))
    const current = links.filter((a) => a.getAttribute('aria-current'))
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/files'])
    const box = (a: Element) =>
      a.className
        .split(' ')
        .filter((c) => /^(h-|border-[ylr]?$|rounded|p[lr]-|-?m[lr]-)/.test(c))
    const other = links.find((a) => a.getAttribute('href') === '/notes')
    if (!other) throw new Error('no notes row')
    expect(box(current[0] ?? other)).toEqual(box(other))
    // No pine bar: the tab is paper on a hairline.
    expect(current[0]?.className).not.toMatch(/primary|pine/)
    expect(current[0]?.className).toContain('bg-paper')
  })
})

describe('the head', () => {
  const mark = () => {
    const el = document.querySelector('img, [data-monogram]')
    if (!el) throw new Error('no workspace mark')
    return el
  }

  it('draws the monogram beside the workspace name when there is no logo', async () => {
    await mount('/today', [], { workspaceName: 'northwind Capital' })
    expect(one('[data-workspace-head]').textContent).toBe('Nnorthwind Capital')
    expect(mark().hasAttribute('data-monogram')).toBe(true)
    expect(mark().getAttribute('style')).toContain('width: 24px')
    expect(mark().className).toContain('font-serif')
  })

  it('opens the workspace menu: General, Members with the active count, Invite for an admin', async () => {
    served.members.push(
      { id: 'a', banned: false },
      { id: 'b', banned: null },
      { id: 'c', banned: true },
    )
    await mount('/today', [], { workspaceName: 'Northwind', isAdmin: true })
    await openMenu(one('[data-workspace-head]'))
    expect(menuItems()).toEqual(['General', 'Members2', 'Invite a member…'])
    expect(one('[data-members-count]').textContent).toBe('2')
  })

  it('leaves Invite out of the workspace menu for a member', async () => {
    await mount('/today', [], { workspaceName: 'Northwind' })
    await openMenu(one('[data-workspace-head]'))
    expect(menuItems()).toEqual(['General', 'Members0'])
  })

  it('draws the logo in its place when one is set', async () => {
    await mount('/today', [], {
      workspaceName: 'Northwind',
      workspaceLogo: '/api/workspace-logo/abc',
    })
    expect(mark().tagName).toBe('IMG')
    expect(mark().getAttribute('src')).toBe('/api/workspace-logo/abc')
  })

  it('keeps the 24px mark when collapsed', async () => {
    await mount('/today', [], { workspaceName: 'Northwind', collapsed: true })
    expect(button(/^Expand sidebar$/).contains(mark())).toBe(true)
    expect(mark().textContent).toBe('N')
    expect(mark().getAttribute('style')).toContain('width: 24px')
  })
})

describe('overflow', () => {
  it('keeps the current row standing when it sits past the limit', () => {
    const { overflow } = sidebar
    const all = [1, 2, 3, 4, 5, 6, 7]
    expect(overflow(all, 5, false, (n) => n === 7)).toEqual({
      shown: [1, 2, 3, 4, 5, 7],
      hidden: 1,
    })
    expect(overflow(all, 5, true, () => false)).toEqual({
      shown: all,
      hidden: 0,
    })
  })
})

describe('pinned views', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
  const pinned = (n: number, name: string, objectSlug = 'companies') => {
    served.views.push({ id: uuid(n), name, objectSlug, visibility: 'shared' })
    prefs.togglePinnedView(uuid(n))
  }
  const after = (label: string) => rows().slice(rows().indexOf(label) + 1)

  it('lists pinned views under their object in pin order, three then a fold', async () => {
    pinned(4, 'Seed, India')
    pinned(2, 'Fintech')
    pinned(3, 'Climate')
    pinned(1, 'Passed')
    pinned(5, 'Hot deals', 'deals')
    await mount('/today')
    expect(after('Companies').slice(0, 4)).toEqual([
      'Seed, India',
      'Fintech',
      'Climate',
      'People',
    ])
    expect(after('Deals').at(0)).toBe('Hot deals')
    const more = button(/Show 1 more pinned views/)
    expect(more.textContent).toBe('▸ 1 more')
    click(more)
    expect(after('Companies').at(3)).toBe('Passed')
    const row = Array.from(nav().querySelectorAll('a')).find(
      (a) => a.textContent === 'Seed, India',
    )
    expect(row?.getAttribute('href')).toBe(`/companies?view=${uuid(4)}`)
  })

  it('never draws a pin the server leaves out, and prunes it from storage', async () => {
    pinned(1, 'Kept')
    // Deleted, or private to someone else: pinned here, absent from the answer.
    prefs.togglePinnedView(uuid(2))
    await mount('/today')
    expect(rows()).toContain('Kept')
    expect(
      JSON.parse(localStorage.getItem('chassis:pinned-views') ?? ''),
    ).toEqual([uuid(1)])
  })

  it('opens the list with the view applied through useViewState, its row the tab', async () => {
    const seed: ViewRow = {
      id: uuid(4),
      surface: 'object',
      objectId: uuid(9),
      name: 'Seed, India',
      filter: [{ slug: 'stage', op: 'is', value: 'seed' }],
      sort: null,
      columns: {},
      extra: {},
      visibility: 'shared',
      createdBy: 'u1',
      updatedAt: '2026-10-10T00:00:00.000Z',
    }
    pinned(4, 'Seed, India')
    const listSearch = z.object({ view: z.string().optional() })

    const {
      Outlet,
      RouterProvider,
      createMemoryHistory,
      createRootRoute,
      createRoute,
      createRouter,
    } = router
    const { AppSidebar } = sidebar
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <AppSidebar user={user} onOpenCommand={() => {}} />
          <Outlet />
        </>
      ),
    })
    const companies = createRoute({
      getParentRoute: () => rootRoute,
      path: 'companies',
      validateSearch: listSearch,
      component: function Companies() {
        // Unregistered in this memory router, so the search is decoded here.
        const { view } = listSearch.parse(companies.useSearch())
        const [columns, setColumns] = useState({})
        const state = useViewState({
          views: [seed],
          activeId: view ?? null,
          columnVisibility: columns,
          setColumnVisibility: setColumns,
          defaultExtra: {},
        })
        return <output data-conditions>{state.conditionKey}</output>
      },
    })
    const r = createRouter({
      routeTree: rootRoute.addChildren([companies]),
      history: createMemoryHistory({ initialEntries: ['/companies'] }),
    })
    await act(async () => {
      await r.load()
      root.render(
        <QueryClientProvider client={queryClient()}>
          <RouterProvider router={r} />
        </QueryClientProvider>,
      )
    })
    await settle()
    const conditions = () =>
      document.querySelector('[data-conditions]')?.textContent
    expect(conditions()).toBe('[]')

    const row = Array.from(nav().querySelectorAll('a')).find(
      (a) => a.textContent === 'Seed, India',
    )
    if (!row) throw new Error('no pinned row')
    await act(async () => {
      row.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(r.state.location.search).toEqual({ view: uuid(4) })
    expect(conditions()).toBe(JSON.stringify(seed.filter))
    const current = Array.from(nav().querySelectorAll('a[aria-current]'))
    expect(current.map((a) => a.textContent)).toEqual(['Seed, India'])
  })
})
