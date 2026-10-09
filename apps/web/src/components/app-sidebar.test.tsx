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

import type * as SidebarModule from './app-sidebar'
import type * as PrefsModule from '#/lib/chassis-prefs'
import type * as RouterModule from '@tanstack/react-router'

/**
 * The chassis, mounted under a memory router: the folding groups, the starred
 * spaces under Spaces, the account row's two icons and the current row's tab.
 *
 * The DOM is a happy-dom `Window` on this file's globals, as in
 * `use-hotkey.test.tsx`, so the per-file database setup stays on node.
 */

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
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const user = { name: 'Anish Badri', email: 'anish@fund.example' }

async function mount(
  path: string,
  objects: Array<{ slug: string; plural: string; icon: string | null }> = [],
) {
  const { AppSidebar } = sidebar
  const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
    router
  const rootRoute = createRootRoute({
    component: () => (
      <AppSidebar user={user} objects={objects} onOpenCommand={() => {}} />
    ),
  })
  const r = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await act(async () => {
    await r.load()
    root.render(<RouterProvider router={r} />)
  })
}

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

describe('the chassis', () => {
  it('draws Work, then Library, Objects and Capital', async () => {
    await mount('/today')
    expect(rows()).toEqual([
      'Today',
      'Tasks',
      'Spaces',
      'Notes',
      'Files',
      'Companies',
      'People',
      'Deals',
      'Portfolio',
      'Mandate',
    ])
  })

  it('folds a group to its heading and count, and remembers it', async () => {
    await mount('/today')
    click(button(/^Library/))
    click(button(/^Capital/))
    expect(rows()).toEqual(
      ['Today', 'Tasks', 'Spaces'].concat(['Companies', 'People', 'Deals']),
    )
    expect(button(/^Library/).textContent).toContain('▸ 2')
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
    const after = rows().slice(rows().indexOf('Spaces') + 1, -7)
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

  it('puts Upload and Settings on the account row as labelled icons', async () => {
    await mount('/today')
    expect(button(/^Upload$/).textContent).toBe('')
    const settings = document.querySelector('a[aria-label="Settings"]')
    expect(settings?.getAttribute('href')).toBe('/settings')
    expect(nav().querySelector('a[href="/settings"]')).toBeNull()
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
