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
import { dayKey, formatWeekday } from '@spaces/core/format'
import type { TodayMeeting } from '#/lib/server-fns'

import type * as TodayModule from '#/routes/_app/today'
import type * as RouterModule from '@tanstack/react-router'

/**
 * Today mounted on a happy-dom `Window`: `‹ ›` moves the Meetings day and
 * the day strip follows it — the day it reads, its blocks and its dither —
 * and `Back to today` brings both home.
 */

// The composer reads the session from the app route; it is not under test.
vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))
vi.mock('sonner', () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}))

/** One meeting at 14:00 on the day asked for, its company named by the day. */
const listDayMeetings = vi.fn(
  ({ data }: { data: { from: string; to: string } }) => {
    const day = dayKey(data.from)
    const [y, m, d] = day.split('-').map(Number)
    const meeting: TodayMeeting = {
      id: `00000000-0000-4000-8000-${day.replaceAll('-', '').padStart(12, '0')}`,
      title: `Catch-up ${day}`,
      startsAt: new Date(y, m - 1, d, 14).toISOString(),
      endsAt: new Date(y, m - 1, d, 15).toISOString(),
      cancelled: false,
      participants: [],
      records: [
        { id: 'c', kind: 'company', name: `Co ${day}`, objectSlug: null },
      ],
      artifacts: [],
      noteId: null,
      external: ['Priya Raman'],
    }
    return Promise.resolve([meeting])
  },
)
vi.mock('#/lib/server-fns', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listDayMeetings: (input: { data: { from: string; to: string } }) =>
    listDayMeetings(input),
  // The window's own read is not under test: it stays reading.
  getMeeting: () => new Promise(() => {}),
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
  listDayMeetings.mockClear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  await settle()
  document.body.replaceChildren()
})

/** Lets the day's read resolve and render. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

function loaded() {
  return {
    empty: false,
    tasks: { open: [] },
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
      moving: [],
      broken: [],
      parked: [],
      waiting: [],
      failing: [],
    }),
    meetings: {
      calendar: true,
      audience: { isAdmin: true, admins: ['Anish'] },
      unwritten: [],
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
  await settle()
}

const meetings = () => {
  const el = document.querySelector('section[aria-label="Meetings"]')
  if (el === null) throw new Error('no Meetings section')
  return el
}
const stripTense = () =>
  document.querySelector('[data-day-strip]')?.getAttribute('data-day-strip')
const stripLabels = () =>
  [...document.querySelectorAll('[data-day-strip] [data-meeting]')].map(
    (el) => el.textContent,
  )
const shownDay = () => meetings().querySelector('[data-day]')?.textContent
const backToToday = () =>
  [...meetings().querySelectorAll('button')].find(
    (b) => b.textContent === 'Back to today',
  )

async function click(el: Element | null | undefined) {
  if (el === null || el === undefined) throw new Error('nothing to click')
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

describe("Today's day nav", () => {
  it('moves the Meetings day and the strip with it, and Back to today brings both home', async () => {
    await mount()
    const now = new Date()
    const day0 = dayKey(now)
    const day1 = dayKey(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
    )
    const dayBack = dayKey(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
    )

    expect(shownDay()).toBe('Today')
    expect(backToToday()).toBeUndefined()
    expect(stripTense()).toBe('today')
    expect(stripLabels()).toEqual([`Co ${day0}`])
    expect(meetings().textContent).toContain(`Catch-up ${day0}`)

    await click(meetings().querySelector('[aria-label="Next day"]'))
    expect(shownDay()).toBe(formatWeekday(day1, day0))
    expect(backToToday()).toBeDefined()
    expect(stripTense()).toBe('future')
    expect(stripLabels()).toEqual([`Co ${day1}`])
    expect(meetings().textContent).toContain(`Catch-up ${day1}`)
    expect(document.querySelector('[data-day-strip] [data-elapsed]')).toBeNull()
    expect(document.querySelector('[data-day-strip] [data-now]')).toBeNull()

    await click(backToToday())
    expect(shownDay()).toBe('Today')
    expect(stripTense()).toBe('today')
    expect(stripLabels()).toEqual([`Co ${day0}`])

    await click(meetings().querySelector('[aria-label="Previous day"]'))
    expect(stripTense()).toBe('past')
    expect(stripLabels()).toEqual([`Co ${dayBack}`])
    expect(
      document
        .querySelector('[data-day-strip] [data-elapsed]')
        ?.getAttribute('width'),
    ).toBe('100%')
    expect(document.querySelector('[data-day-strip] [data-now]')).toBeNull()

    // One read per day shown: the strip reads nothing of its own.
    expect(
      listDayMeetings.mock.calls.map(([c]) => dayKey(c.data.from)),
    ).toEqual([day0, day1, day0, dayBack])
  })

  it('opens the meeting window from a strip block', async () => {
    await mount()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(document.querySelector('[data-meeting-block]'))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
