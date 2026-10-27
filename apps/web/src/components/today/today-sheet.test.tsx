import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Route as TodayRoute } from '#/routes/_app/today'
import { DayStrip, nowLabel, windowPercent } from './day-strip'
import type { DayStripMeeting } from './day-strip'
import { todayReadouts } from './readouts'

/**
 * Today: a head with the date line and no verbs, the day strip only with a
 * calendar, non-zero readouts that filter Needs you, the body in order —
 * notices, Needs you, Meetings — and the rail's Portfolio and What's moving.
 */

// The composer reads the session from the app route; it is not under test.
vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))

const ME = 'u-me'

const task = (i: number, assigneeId = 'u-anika') => ({
  id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
  content: `Task ${i}`,
  dueDate: '2000-01-01',
  entities: [],
  assigneeId,
  assigneeName: assigneeId === ME ? 'Me' : 'Anika Rao',
})

const holding = (id: string, currency: string) => ({
  id,
  companyName: id,
  sensitive: false,
  // Cost 0 keeps them out of the stale-mark rows; the rollup is given.
  metrics: {
    ok: true,
    metrics: {
      currency,
      writtenOff: false,
      costBasis: 0,
      unrealized: 0,
      lastMarkDate: null,
    },
  },
})

const attention = {
  review: [],
  moving: [],
  broken: [],
  parked: [],
  waiting: [],
  failing: [],
}

function loadedWith(over: {
  tasks?: Array<ReturnType<typeof task>>
  unfiledCount?: number
  calendar?: boolean
}) {
  return {
    empty: false,
    tasks: {
      open: over.tasks ?? Array.from({ length: 10 }, (_, i) => task(i)),
    },
    holdings: {
      baseCurrency: 'USD',
      holdings: [holding('h1', 'USD'), holding('h2', 'EUR')],
      rollup: {
        costBasis: 100_000,
        realized: 50_000,
        unrealized: 150_000,
        moic: 2,
        grossXirr: null,
        excludedForMissingRates: ['h2'],
      },
    },
    funnel: { daysInStage: [], medianDaysInStage: {} },
    team: [],
    dealRegistry: [],
    unfiledCount: over.unfiledCount ?? 3,
    stoppedPlugins: [],
    // Deferred, as the loader hands it back.
    attention: Promise.resolve(attention),
    meetings: {
      calendar: over.calendar ?? false,
      audience: { isAdmin: true, admins: ['Anish'] },
      unwritten: [
        {
          id: '00000000-0000-4000-8000-0000000000aa',
          title: 'Flent intro',
          startsAt: '2000-01-01T09:00:00.000Z',
          record: 'Flent',
          who: 'Priya Raman',
          sensitive: null,
        },
      ],
    },
  }
}

async function renderToday(loaded: ReturnType<typeof loadedWith>) {
  const component = TodayRoute.options.component
  if (component === undefined) throw new Error('Today has no component')
  const root = createRootRoute()
  const app = createRoute({
    getParentRoute: () => root,
    id: '_app',
    beforeLoad: () => ({ session: { user: { id: ME, name: 'Me' } } }),
    component: () => <Outlet />,
  })
  const today = createRoute({
    getParentRoute: () => app,
    path: 'today',
    loader: () => loaded,
    component,
  })
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([today])]),
    history: createMemoryHistory({ initialEntries: ['/today'] }),
  })
  await router.load()
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** The class of the element whose whole text is `text`. */
function classOf(html: string, text: string): string | undefined {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`class="([^"]*)"[^>]*>${escaped}<`).exec(html)?.[1]
}

describe('Today', () => {
  it('heads the page with the date line over the title, and no buttons', async () => {
    const html = await renderToday(loadedWith({}))
    const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? ''
    expect(header).toContain('<h1')
    expect(header).not.toContain('<button')
    const date = header.search(
      /(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2} [A-Z][a-z]{2} · W\d+/,
    )
    expect(date).toBeGreaterThan(-1)
    expect(date).toBeLessThan(header.indexOf('<h1'))
    expect(html).not.toMatch(/>New task</)
    expect(html).not.toMatch(/>Log interaction</)
  })

  it('draws the day strip only with a calendar connected', async () => {
    expect(await renderToday(loadedWith({}))).not.toContain('data-day-strip')
    expect(await renderToday(loadedWith({ calendar: true }))).toContain(
      'data-day-strip',
    )
  })

  it('shows only the non-zero readouts: a filter is a pressed button, Unfiled a link', async () => {
    const html = await renderToday(loadedWith({}))
    expect(html).toContain('data-readouts')
    expect(html).toMatch(
      /<button type="button" aria-pressed="false"[^>]*><span[^>]*>10<\/span><span[^>]*>Overdue</,
    )
    expect(html).toContain('href="/files?filed=unfiled"')
    expect(classOf(html, 'Unfiled files')).toContain('text-label')
    // No deals past median and no marks: neither readout is drawn.
    expect(html).not.toContain('Deals past stage median')
    expect(html).not.toContain('Oldest mark')
    // The value in the strip's mono, at the page step.
    expect(html).toMatch(/class="[^"]*mono text-page[^"]*">3<\/span>/)

    // Today draws none of its own: the strip is the record primitive.
    const source = readFileSync(
      new URL('../../routes/_app/today.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain(
      "import { ReadoutStrip } from '#/components/record/record-parts'",
    )
  })

  it('draws no readout strip when every figure is zero', async () => {
    const html = await renderToday(
      loadedWith({
        tasks: [{ ...task(1), dueDate: '2999-01-01' }],
        unfiledCount: 0,
      }),
    )
    expect(html).not.toContain('data-readouts')
  })

  it('orders the body Notices, Needs you, Meetings', async () => {
    const html = await renderToday(loadedWith({}))
    const needs = html.indexOf('aria-label="Needs you"')
    const meetings = html.indexOf('aria-label="Meetings"')
    expect(needs).toBeGreaterThan(-1)
    expect(meetings).toBeGreaterThan(needs)
    expect(html).toContain('No calendar connected')
  })

  it('filters by kind in a Segmented, and the fold names the kinds', async () => {
    const html = await renderToday(loadedWith({}))
    expect(html).toContain('aria-label="Needs you by kind"')
    expect(html).toMatch(/aria-checked="true"[^>]*>All</)
    expect(html).toMatch(/>Tasks<span data-segment-count[^>]*>10</)
    expect(html).toMatch(/>Meetings<span data-segment-count[^>]*>1</)
    expect(html).not.toMatch(/>Deals</)
    expect(html).toContain('3 more · 2 tasks · 1 meeting')
    expect(html).toContain('Show all ›')
    // Review is still coming: the loading row holds its place.
    expect(html).toContain('Loading what needs you')
  })

  it("leaves the reader's own task with an empty who lane (H2)", async () => {
    const html = await renderToday(
      loadedWith({ tasks: [task(1, ME), task(2, 'u-anika')] }),
    )
    expect(html).toMatch(/w-30[^>]*>Anika Rao</)
    expect(html).not.toMatch(/w-30[^>]*>Me</)
  })

  it('heads the rail in graphite caps with Invested, Value, MOIC and the rates line', async () => {
    const html = await renderToday(loadedWith({}))
    expect(classOf(html, 'Portfolio')).toContain('label-caps')
    expect(classOf(html, 'Portfolio')).toContain('text-graphite')
    for (const label of ['Invested', 'Value', 'MOIC'])
      expect(classOf(html, label)).toContain('text-label')
    expect(html).not.toContain('Realized')
    expect(html).toContain('1 holding out of the totals')
    expect(html).toContain('Set rates ›')
  })

  it("reads What's moving after the page, behind a Twinkle", async () => {
    const html = await renderToday(loadedWith({}))
    expect(classOf(html, 'What&#x27;s moving')).toContain('label-caps')
    expect(html).toContain('Reading signals')
  })
})

describe('the day strip', () => {
  const strip = (day: string, meetings: ReadonlyArray<DayStripMeeting> = []) =>
    renderToStaticMarkup(
      <DayStrip
        day={day}
        today="2026-10-13"
        meetings={meetings}
        onOpen={() => {}}
      />,
    )

  it('spans the working window 08–20', () => {
    const html = strip('2026-10-13')
    for (const h of ['08', '10', '12', '14', '16', '18', '20'])
      expect(html).toContain(`>${h}<`)
    for (const h of ['00', '06', '21']) expect(html).not.toContain(`>${h}<`)
  })

  it('dithers a past day whole with no now-dot, and a future day not at all', () => {
    const past = strip('2026-10-12')
    expect(past).toContain('data-day-strip="past"')
    expect(past).toMatch(/data-elapsed[^>]*width="100%"/)
    expect(past).not.toContain('data-now')

    const ahead = strip('2026-10-14')
    expect(ahead).toContain('data-day-strip="future"')
    expect(ahead).not.toContain('data-elapsed')
    expect(ahead).not.toContain('data-now')
  })

  it('places now on the window and prints it beside the dot', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m)
    expect(windowPercent(at(8))).toBe(0)
    expect(windowPercent(at(14))).toBe(50)
    expect(windowPercent(at(20))).toBe(100)
    // Outside the window the dot rests on its edge.
    expect(windowPercent(at(6, 30))).toBe(0)
    expect(windowPercent(at(22))).toBe(100)
    expect(nowLabel(at(11, 40))).toBe('Now · 11:40')
    expect(nowLabel(at(9, 5))).toBe('Now · 09:05')
  })

  it('draws a meeting as a labelled block that opens its window', () => {
    const day = (h: number) => new Date(2026, 9, 14, h).toISOString()
    const html = strip('2026-10-14', [
      {
        id: 'm',
        label: 'Northgate',
        title: 'Northgate catch-up',
        who: 'Priya Raman +1',
        startsAt: day(17),
        endsAt: day(18),
      },
    ])
    expect(html).toMatch(/data-meeting[^>]*>Northgate</)
    expect(html).toMatch(
      /<button[^>]*data-meeting-block[^>]*aria-label="Northgate catch-up · 17:00–18:00"/,
    )
    expect(html).toContain('hover:outline-foreground')
  })
})

describe('todayReadouts', () => {
  const read = (n: number, oldest: number | null) =>
    todayReadouts({
      overdue: n,
      pastMedian: n,
      oldestMarkAge: oldest,
      unfiled: n,
    })

  it('hides every zero figure, and is empty when all are zero', () => {
    expect(read(0, null)).toEqual([])
    expect(read(0, 12).map((r) => r.cell.label)).toEqual(['Oldest mark'])
  })

  it('is destructive only when bad: Overdue, and a mark past 180 days', () => {
    expect(read(2, 200).map((r) => r.cell.tone)).toEqual([
      'bad',
      undefined,
      'bad',
      undefined,
    ])
    expect(read(2, 30).map((r) => r.cell.tone)).toEqual([
      'bad',
      undefined,
      undefined,
      undefined,
    ])
  })

  it('maps the three figures to their Needs-you filters; Unfiled stays a link', () => {
    const cells = read(2, 200)
    expect(cells.map((r) => r.filter?.id)).toEqual([
      'overdue',
      'pastMedian',
      'oldestMark',
      undefined,
    ])
    expect(cells.at(3)?.cell.to).toBe('/files')
  })
})
