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

import type * as TodayModule from '#/routes/_app/today'
import type * as RouterModule from '@tanstack/react-router'

/**
 * Today mounted on a happy-dom `Window`: a readout is a toggle on Needs you.
 * Pressing it adds its segment after `All` and keeps the rows it counted;
 * pressing it again clears both.
 */

// The composer reads the session from the app route; it is not under test.
vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))
vi.mock('sonner', () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let today: typeof TodayModule
let router: typeof RouterModule

class StubObserver {
  observe() {}
  disconnect() {}
}

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('localStorage', win.localStorage)
  vi.stubGlobal('IntersectionObserver', StubObserver)
  vi.stubGlobal('ResizeObserver', StubObserver)
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      vi.stubGlobal(name, Reflect.get(win, name))
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  today = await import('#/routes/_app/today')
  router = await import('@tanstack/react-router')
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  document.body.replaceChildren()
})

const task = (i: number, dueDate: string) => ({
  id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
  content: `Task ${i}`,
  dueDate,
  entities: [],
  assigneeId: 'u-anika',
  assigneeName: 'Anika Rao',
})

/** Two late tasks, one due today, one meeting nobody wrote up. */
function loaded() {
  const day = new Date()
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  return {
    empty: false,
    tasks: {
      open: [task(1, '2000-01-01'), task(2, '2000-01-02'), task(3, iso)],
    },
    holdings: {
      baseCurrency: 'USD',
      holdings: [],
      rollup: {
        costBasis: 0,
        realized: 0,
        unrealized: 0,
        moic: null,
        grossXirr: null,
        excludedForMissingRates: [],
      },
    },
    funnel: { daysInStage: [], medianDaysInStage: {} },
    team: [],
    dealRegistry: [],
    unfiledCount: 0,
    stoppedPlugins: [],
    attention: Promise.resolve({
      review: [],
      filedIn: {},
      moving: [],
      broken: [],
      parked: [],
      waiting: [],
      failing: [],
    }),
    meetings: {
      calendar: false,
      audience: { isAdmin: true, admins: ['Anish'] },
      unwritten: [
        {
          id: '00000000-0000-4000-8000-0000000000aa',
          title: 'Flent intro',
          startsAt: '2000-01-01T09:00:00.000Z',
          record: 'Flent',
          who: null,
          sensitive: null,
        },
      ],
    },
  }
}

async function mount() {
  const component = today.Route.options.component
  if (component === undefined) throw new Error('Today has no component')
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
    beforeLoad: () => ({ session: { user: { id: 'u-me', name: 'Me' } } }),
    component: () => <Outlet />,
  })
  const page = createRoute({
    getParentRoute: () => app,
    path: 'today',
    loader: () => loaded(),
    component,
  })
  const r = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: ['/today'] }),
  })
  await act(async () => {
    await r.load()
    root.render(<RouterProvider router={r} />)
  })
}

const rowKinds = () =>
  [...document.querySelectorAll('[data-needs-row]')].map((el) =>
    el.getAttribute('data-needs-row'),
  )
const overdue = () => {
  const cell = [
    ...document.querySelectorAll('[data-readouts] button[aria-pressed]'),
  ].find((el) => el.textContent.includes('Overdue'))
  if (!cell) throw new Error('no Overdue readout')
  return cell
}
const segments = () =>
  [
    ...document.querySelectorAll(
      '[aria-label="Needs you by kind"] [role="radio"]',
    ),
  ].map((el) => ({
    label: el.textContent,
    checked: el.getAttribute('aria-checked') === 'true',
  }))

describe("Today's readouts filter Needs you", () => {
  it('a press adds the segment after All and keeps the late tasks; a second press clears it', async () => {
    await mount()
    expect(rowKinds()).toEqual(['task', 'task', 'task', 'meeting'])
    expect(overdue().getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      overdue().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(overdue().getAttribute('aria-pressed')).toBe('true')
    expect(rowKinds()).toEqual(['task', 'task'])
    expect(segments().slice(0, 2)).toEqual([
      { label: 'All', checked: false },
      { label: 'Overdue2', checked: true },
    ])

    await act(async () => {
      overdue().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(overdue().getAttribute('aria-pressed')).toBe('false')
    expect(rowKinds()).toEqual(['task', 'task', 'task', 'meeting'])
    expect(segments().map((s) => s.label)).not.toContain('Overdue2')
    expect(segments().at(0)).toEqual({ label: 'All', checked: true })
  })
})
