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
import type { HoldingMetrics } from '@spaces/core/portfolio/metrics'
import { Route as TodayRoute } from '#/routes/_app/today'
import { DayStrip, nowLabel, windowPercent } from './day-strip'
import { unpricedCurrencies } from './rail'
import { todayReadouts } from './readouts'

/**
 * Today: the shared readout strip, the date line over the
 * title with New task and Log interaction, the 08–20 day strip, sentence-case
 * kind filters with a fold that names its kinds, the Portfolio rail and a
 * What's moving that is drawn even on a quiet week.
 */

// The composer reads the session from the app route; it is not under test.
vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))

const task = (i: number) => ({
  id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
  content: `Task ${i}`,
  dueDate: '2000-01-01',
  entities: [],
  assigneeName: null,
})

const holding = (id: string, currency: string) => ({
  id,
  companyName: id,
  // Cost 0 keeps them out of the stale-mark rows; the rollup is given.
  metrics: {
    ok: true,
    metrics: { currency, writtenOff: false, costBasis: 0, lastMarkDate: null },
  },
})

const loaded = {
  empty: false,
  tasks: { open: Array.from({ length: 10 }, (_, i) => task(i)) },
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
  unfiledCount: 3,
  stoppedPlugins: [],
  attention: {
    review: [],
    moving: [],
    broken: [],
    parked: [],
    waiting: [],
    failing: [],
  },
  meetings: {
    calendar: false,
    audience: { isAdmin: true, admins: ['Anish'] },
    unwritten: [
      {
        id: '00000000-0000-4000-8000-0000000000aa',
        title: 'Flent intro',
        startsAt: '2000-01-01T09:00:00.000Z',
        record: 'Flent',
      },
    ],
  },
}

async function renderToday() {
  const component = TodayRoute.options.component
  if (component === undefined) throw new Error('Today has no component')
  const root = createRootRoute()
  const app = createRoute({
    getParentRoute: () => root,
    id: '_app',
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

describe('Today by sheet 00', () => {
  it('draws its readouts through the shared ReadoutStrip, the number over a sentence-case label', async () => {
    const html = await renderToday()
    expect(html).toContain('data-readouts')
    for (const label of [
      'Overdue',
      'Deals past stage median',
      'Oldest mark',
      'Unfiled files',
    ]) {
      expect(classOf(html, label)).toContain('text-label')
      expect(classOf(html, label)).not.toContain('field-label')
    }
    // The value first, in the record strip's mono 22, not 20px.
    const unfiled = /class="([^"]*)">3<\/span><span[^>]*>Unfiled files</.exec(
      html,
    )?.[1]
    expect(unfiled).toContain('mono text-page')
    expect(html).toMatch(/>10<\/span><span[^>]*>Overdue</)
    expect(html).toContain('href="/files?filed=unfiled"')
    expect(html).not.toContain('text-xl')

    // Today draws none of its own: the strip is the record primitive.
    const source = readFileSync(
      new URL('../../routes/_app/today.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain(
      "import { ReadoutStrip } from '#/components/record/record-parts'",
    )
    expect(source).not.toMatch(/field-label|text-xl/)
  })

  it('puts the date line above the title and New task, Log interaction in the head', async () => {
    const html = await renderToday()
    const h1 = html.indexOf('<h1')
    const date = html.search(
      /(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2} [A-Z][a-z]{2} · W\d+/,
    )
    expect(date).toBeGreaterThan(-1)
    expect(date).toBeLessThan(h1)
    expect(classOf(html, html.slice(date).split('<')[0])).toContain(
      'normal-case',
    )
    // The keys are in the buttons' tooltips, never printed inside them.
    expect(html).toMatch(/data-state="closed"[^>]*>New task<\/button>/)
    expect(html).toMatch(/data-state="closed"[^>]*>Log interaction<\/button>/)
  })

  it('filters the ledger by kind in sentence case, and the fold names the kinds', async () => {
    const html = await renderToday()
    expect(html).toContain('aria-label="Needs you by kind"')
    expect(html).not.toContain('role="tab"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>All</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>Tasks 10</)
    // A kind with nothing in it has no filter.
    expect(html).not.toContain('Deals 0')
    // A past meeting nobody wrote up is its own kind, after tasks.
    expect(html).toMatch(/aria-pressed="false"[^>]*>Meetings 1</)
    expect(html).toContain('+ 3 more · 2 tasks · 1 meeting')
    expect(html).toContain('show all ›')
  })

  it('opens Meetings on the D80 line with no calendar connected', async () => {
    const html = await renderToday()
    expect(html).toContain('aria-label="Meetings"')
    expect(html).toContain('No calendar connected · ')
    expect(html).toContain('Connect Google ›')
  })

  it('heads the rail PORTFOLIO with Invested, Value, MOIC and the rate to add', async () => {
    const html = await renderToday()
    expect(classOf(html, 'Portfolio')).toContain('label-caps')
    expect(html).toContain('USD · 2 holdings')
    for (const label of ['Invested', 'Value', 'MOIC'])
      expect(classOf(html, label)).toContain('field-label')
    expect(html).not.toContain('Realized')
    expect(html).toContain('1 holding unpriced')
    expect(html).toContain('add EUR→USD ›')
  })

  it("draws What's moving on a quiet week as one line", async () => {
    const html = await renderToday()
    expect(classOf(html, 'What&#x27;s moving')).toContain('label-caps')
    expect(html).toContain('your companies · 7d')
    expect(html).toContain('Nothing new in 7 days.')
  })
})

describe('the day strip', () => {
  it('spans the working window 08–20', () => {
    const html = renderToStaticMarkup(<DayStrip />)
    for (const h of ['08', '10', '12', '14', '16', '18', '20'])
      expect(html).toContain(`>${h}<`)
    for (const h of ['00', '06', '21']) expect(html).not.toContain(`>${h}<`)
  })

  it('places now on the window and prints it beside the dot', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m)
    expect(windowPercent(at(8))).toBe(0)
    expect(windowPercent(at(14))).toBe(50)
    expect(windowPercent(at(20))).toBe(100)
    // Outside the window the dot rests on its edge.
    expect(windowPercent(at(6, 30))).toBe(0)
    expect(windowPercent(at(22))).toBe(100)
    expect(nowLabel(at(11, 40))).toBe('now · 11:40')
    expect(nowLabel(at(9, 5))).toBe('now · 09:05')
  })

  it('draws a meeting as a named block', () => {
    const day = (h: number) => new Date(2026, 9, 10, h).toISOString()
    const html = renderToStaticMarkup(
      <DayStrip
        meetings={[
          { id: 'm', title: 'Northgate', startsAt: day(17), endsAt: day(18) },
        ]}
      />,
    )
    expect(html).toMatch(/data-meeting[^>]*>Northgate</)
  })
})

describe('todayReadouts', () => {
  const tones = (n: number) =>
    todayReadouts({
      overdue: n,
      pastMedian: n,
      oldestMarkAge: n === 0 ? null : 200,
      unfiled: n,
    }).map((r) => r.tone)

  it('colours a nonzero bad value: overdue crimson, past median amber', () => {
    expect(tones(2)).toEqual(['bad', 'warn', 'bad', undefined])
  })

  it('reads every zero graphite', () => {
    expect(tones(0)).toEqual(['muted', 'muted', undefined, 'muted'])
  })
})

const holdingMetricsIn = (currency: string): HoldingMetrics => ({
  currency,
  costBasis: 100,
  realized: 0,
  unrealized: 100,
  lastMarkDate: null,
  writtenOff: false,
  moic: 1,
  tvpi: 1,
  rvpi: 1,
  dpi: 0,
  grossXirr: null,
})

describe('unpricedCurrencies', () => {
  it('names the currency each left-out holding waits on, once', () => {
    expect(
      unpricedCurrencies(
        [
          {
            id: 'a',
            metrics: {
              ok: false,
              missingRates: [
                { currency: 'SGD', date: '2026-01-01' },
                { currency: 'EUR', date: '2026-02-01' },
              ],
            },
          },
          { id: 'b', metrics: { ok: true, metrics: holdingMetricsIn('EUR') } },
          { id: 'c', metrics: { ok: true, metrics: holdingMetricsIn('INR') } },
        ],
        ['a', 'b'],
      ),
    ).toEqual(['EUR', 'SGD'])
  })
})
