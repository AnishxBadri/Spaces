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

import type * as ChassisModule from './settings-chassis'
import type * as ReturnModule from '#/lib/settings-return'
import type * as RouterModule from '@tanstack/react-router'

/**
 * Settings takes the chassis over: on a settings route the sidebar is
 * `‹ Settings` over the settings nav, and `‹` or `esc` goes back to the page
 * settings was opened from — Today on a cold load.
 *
 * Mounted under a memory router whose tree mirrors the app's `_app` →
 * `settings` ids, on a happy-dom `Window` as in the sidebar's test.
 */

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let chassis: typeof ChassisModule
let back: typeof ReturnModule
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
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  // The router restores scroll after each navigation.
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  chassis = await import('./settings-chassis')
  back = await import('#/lib/settings-return')
  router = await import('@tanstack/react-router')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  back.forgetAppPage()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

/** What the settings shell's loader hands the nav. */
const shellData = {
  isAdmin: true,
  members: [{}, {}],
  templates: [],
  objects: [{}],
  fx: { rates: [] },
  integrations: 3,
}

async function mount(path: string) {
  const { SettingsChassis, useSettingsTakeover } = chassis
  const {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
  } = router
  function Shell() {
    const onSettings = useSettingsTakeover()
    return (
      <>
        <aside>
          {onSettings ? <SettingsChassis /> : <nav aria-label="Primary" />}
        </aside>
        <Outlet />
      </>
    )
  }
  const rootRoute = createRootRoute()
  const app = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    component: Shell,
  })
  const page = (p: string) =>
    createRoute({
      getParentRoute: () => app,
      path: p,
      component: () => <p>{p} page</p>,
    })
  const settings = createRoute({
    getParentRoute: () => app,
    path: 'settings',
    loader: () => shellData,
  })
  const general = createRoute({
    getParentRoute: () => settings,
    path: 'general',
    component: () => <input aria-label="Workspace name" />,
  })
  const r = createRouter({
    routeTree: rootRoute.addChildren([
      app.addChildren([
        page('today'),
        page('deals'),
        settings.addChildren([general]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await act(async () => {
    await r.load()
    root.render(<RouterProvider router={r} />)
  })
  return r
}

const go = async (r: { navigate: (o: { href: string }) => Promise<void> }) =>
  act(async () => {
    await r.navigate({ href: '/settings/general' })
  })

const escape = (target: { dispatchEvent: (e: Event) => boolean }) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const settingsNav = () =>
  document.querySelector('nav[aria-label="Settings sections"]')

const backButton = () => {
  const hit = document.querySelector('button[aria-label="Settings — go back"]')
  if (!(hit instanceof HTMLElement)) throw new Error('no ‹ Settings')
  return hit
}

describe('the settings chassis', () => {
  it('replaces the app nav with ‹ Settings over the four groups', async () => {
    const r = await mount('/deals')
    expect(document.querySelector('nav[aria-label="Primary"]')).not.toBeNull()
    expect(settingsNav()).toBeNull()

    await go(r)
    expect(document.querySelector('nav[aria-label="Primary"]')).toBeNull()
    // The head reads `‹ Settings` and prints no key hint beside it.
    expect(backButton().textContent).toBe('‹Settings')
    expect(backButton().querySelector('kbd')).toBeNull()
    const groups = Array.from(
      settingsNav()?.querySelectorAll('.label-caps') ?? [],
    ).map((el) => el.textContent)
    expect(groups).toEqual(['You', 'Workspace', 'AI', 'Integrations'])
    // The shell's counts reach the right lane.
    expect(
      settingsNav()?.querySelector('a[href="/settings/plugins"]')?.textContent,
    ).toContain('3')
  })

  it('goes back on esc to the page settings was opened from, query and all', async () => {
    const r = await mount('/deals?view=v1')
    await go(r)
    await escape(document)
    expect(r.state.location.href).toBe('/deals?view=v1')
    expect(settingsNav()).toBeNull()
  })

  it('goes back on ‹ too, and to Today on a cold load into settings', async () => {
    const r = await mount('/settings/general')
    await act(async () => {
      backButton().click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(r.state.location.pathname).toBe('/today')
  })

  it('leaves esc to a field, and to a popover that spent it', async () => {
    const r = await mount('/deals')
    await go(r)
    const field = document.querySelector('input')
    if (!field) throw new Error('no field')
    await escape(field)
    expect(r.state.location.pathname).toBe('/settings/general')

    const spent = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
    })
    spent.preventDefault()
    expect(chassis.isLeaveSettingsKey(spent)).toBe(false)
  })
})
