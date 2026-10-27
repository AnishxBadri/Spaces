import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NeedsYou } from './needs-you'
import type { NeedsYouRow } from './needs-you'
import type { ReviewGroup } from '#/lib/server-fns'
import type { NeedsFilter } from '#/lib/today/needs-you'

/**
 * The Needs-you rows: one set of lanes for every kind — kind, mark, body,
 * action, who, figure, `···` — and a Review group that opens Review on its
 * source and space.
 */

// The composer reads the session from the app route; it is not under test.
vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))

const SPACE = '00000000-0000-4000-8000-000000000001'
const EXA = '00000000-0000-4000-8000-0000000000e1'

const group = (over: Partial<ReviewGroup>): ReviewGroup => ({
  key: `Exa|${SPACE}|discovery`,
  spaceId: SPACE,
  spaceLabel: 'Proptech / Property ops',
  source: 'Exa',
  sourceRef: EXA,
  toAdd: 3,
  toFile: 1,
  toReview: 0,
  total: 4,
  oldestAt: '2026-10-08T09:00:00.000Z',
  ...over,
})

const task = (
  over: Partial<Extract<NeedsYouRow, { kind: 'task' }>> = {},
): NeedsYouRow => ({
  kind: 'task',
  key: 'task:t1',
  weight: 2,
  sensitive: null,
  task: {
    id: '00000000-0000-4000-8000-00000000000a',
    content: 'Chase the data room',
    dueDate: '2026-10-08',
    assigneeId: 'u2',
    entities: [],
  },
  record: 'Flent',
  who: 'Anika Rao',
  due: '−2d',
  late: true,
  ...over,
})

const deal: NeedsYouRow = {
  kind: 'deal',
  key: 'deal:d1',
  weight: 10,
  sensitive: null,
  id: '00000000-0000-4000-8000-0000000000d1',
  name: 'Exponent Seed',
  stage: 'Diligence',
  days: 32,
  median: 14,
  who: 'Priya Raman',
}

const mark: NeedsYouRow = {
  kind: 'mark',
  key: 'mark:h1',
  weight: 214,
  sensitive: 'Northgate',
  holdingId: '00000000-0000-4000-8000-0000000000b1',
  company: 'Northgate',
  value: '$3.0M',
  age: 214,
}

const meeting: NeedsYouRow = {
  kind: 'meeting',
  key: 'meeting:m1',
  weight: 2,
  sensitive: null,
  id: 'm1',
  title: 'Flent intro',
  record: 'Flent',
  who: 'Priya Raman',
  figure: '2d',
}

async function render(
  rows: ReadonlyArray<NeedsYouRow>,
  {
    filter = 'all',
    loading = false,
  }: { filter?: NeedsFilter; loading?: boolean } = {},
) {
  const root = createRootRoute({
    component: () => (
      <NeedsYou
        rows={rows}
        filter={filter}
        onFilter={() => {}}
        readout={null}
        loading={loading}
        onComplete={() => {}}
        onOpen={() => {}}
        taskMenu={() => [
          { label: 'Due date…', onSelect: () => {} },
          { label: 'Assign…', onSelect: () => {} },
        ]}
        onCreated={() => {}}
        washes={() => false}
      />
    ),
  })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

/** The markup of the one row of `kind`. */
function rowOf(html: string, kind: string): string {
  const at = html.indexOf(`data-needs-row="${kind}"`)
  if (at === -1) throw new Error(`no ${kind} row`)
  const end = html.indexOf('</li>', at)
  return html.slice(at, end)
}

describe('the Needs-you lanes', () => {
  it('draws a task: caps kind, checkbox, body and record, who, a bad figure, the ···', async () => {
    const html = rowOf(await render([task()]), 'task')
    expect(html).toMatch(/w-16[^"]*label-caps[^"]*text-graphite[^>]*>task</)
    expect(html).toContain('aria-label="Complete task"')
    expect(html).toMatch(/text-body text-foreground[^>]*>Chase the data room</)
    expect(html).toMatch(/text-label[^>]*>Flent</)
    expect(html).toMatch(/w-30[^>]*>Anika Rao</)
    expect(html).toMatch(/w-12[^"]*text-destructive[^>]*>−2d</)
    expect(html).toContain('href="/tasks?task=')
    // The row `···` is the task menu.
    expect(html).toContain('aria-label="More for Chase the data room"')
  })

  it("leaves the who lane blank on the reader's own task (H2)", async () => {
    const html = rowOf(await render([task({ who: null })]), 'task')
    expect(html).toMatch(
      /w-30 shrink-0 truncate text-label text-graphite"><\/span>/,
    )
    expect(html).not.toContain('Anika Rao')
  })

  it('draws a deal: its stage, days against the median, the owner, days in stage', async () => {
    const html = rowOf(await render([deal]), 'deal')
    expect(html).toContain('href="/deals/00000000-0000-4000-8000-0000000000d1"')
    expect(html).toMatch(/>Exponent Seed</)
    expect(html).toMatch(/>Diligence</)
    expect(html).toContain('title="Median 14d in Diligence"')
    expect(html).toMatch(/<svg width="120" height="8"/)
    expect(html).toMatch(/w-30[^>]*>Priya Raman</)
    expect(html).toMatch(/text-destructive[^>]*>32d</)
  })

  it('draws a mark: the value in mono, no who, the age, and a lock when sensitive', async () => {
    const html = rowOf(await render([mark]), 'mark')
    expect(html).toMatch(/>Northgate</)
    expect(html).toMatch(/mono text-micro[^>]*>\$3\.0M</)
    expect(html).not.toContain('last mark')
    expect(html).not.toContain('record mark')
    expect(html).toMatch(/text-destructive[^>]*>214d</)
    expect(html).toContain('aria-label="Sensitive · AI never reads Northgate"')
  })

  it('draws a meeting: Write in the action lane, the first external participant', async () => {
    const html = rowOf(await render([meeting]), 'meeting')
    expect(html).toMatch(/>Flent intro</)
    expect(html).toMatch(/<button[^>]*>Write<\/button>/)
    expect(html).toMatch(/w-30[^>]*>Priya Raman</)
    expect(html).toMatch(/>2d</)
  })

  it("counts a space's add and file cards and opens Review on that source and space", async () => {
    const g = group({})
    const html = rowOf(
      await render([
        {
          kind: 'review',
          key: `review:${g.key}`,
          weight: g.total,
          sensitive: null,
          group: g,
          figure: '2d',
        },
      ]),
      'review',
    )
    expect(html).toContain('Proptech / Property ops')
    expect(html).toContain('3 to add · 1 to file')
    expect(html).toMatch(/w-30[^>]*>Via Exa</)
    expect(html).toContain(`href="/review?source=${EXA}&amp;space=${SPACE}"`)
  })

  it('opens Review on Judgment alone for a row filed nowhere', async () => {
    const g = group({
      key: 'judgment|',
      spaceId: null,
      spaceLabel: null,
      source: 'Judgment',
      sourceRef: 'judgment',
      toAdd: 0,
      toFile: 0,
      toReview: 2,
      total: 2,
    })
    const html = await render([
      {
        kind: 'review',
        key: `review:${g.key}`,
        weight: g.total,
        sensitive: null,
        group: g,
        figure: null,
      },
    ])
    expect(html).toContain('2 to review')
    expect(html).toContain('href="/review?source=judgment"')
    expect(html).not.toContain('space=')
  })
})

describe('the Needs-you head', () => {
  it('carries no count, and a Segmented of the kinds that have rows', async () => {
    const html = await render([task(), deal, mark])
    expect(html).not.toContain('data-section-count')
    expect(html).toContain('aria-label="Needs you by kind"')
    expect(html).toMatch(/aria-checked="true"[^>]*>All</)
    for (const label of ['Tasks', 'Deals', 'Marks'])
      expect(html).toMatch(new RegExp(`>${label}<span data-segment-count`))
    expect(html).not.toMatch(/>Review</)
    expect(html).not.toMatch(/>Meetings</)
  })

  it('shows the loading row while the attention read is out', async () => {
    const html = await render([task()], { loading: true })
    expect(html).toContain('data-twinkle')
    expect(html).toContain('Loading what needs you')
  })
})

describe('the Needs-you fold', () => {
  const tasks = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      task({ key: `task:${i}`, task: { ...taskOf(i) } }),
    )
  const taskOf = (i: number) => ({
    id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
    content: `Task ${i}`,
    dueDate: '2026-10-08',
    assigneeId: 'u2',
    entities: [],
  })

  it('folds eleven rows at eight and names what it hides', async () => {
    const html = await render(tasks(11))
    expect(html.match(/data-needs-row="task"/g)).toHaveLength(8)
    expect(html).toContain('3 more · 3 tasks')
    expect(html).toContain('Show all ›')
  })

  it('shows ten rows whole rather than fold two away', async () => {
    const html = await render(tasks(10))
    expect(html.match(/data-needs-row="task"/g)).toHaveLength(10)
    expect(html).not.toContain('Show all ›')
  })
})
