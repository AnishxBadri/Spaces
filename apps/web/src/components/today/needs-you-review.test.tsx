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

/**
 * Today's review row: a space's open discovery cards as one row,
 * "Proptech / Property ops · via Exa · 3 to add · 1 to file", linking to
 * Review filtered by that source and space.
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

async function render(rows: ReadonlyArray<NeedsYouRow>) {
  const root = createRootRoute({
    component: () => (
      <NeedsYou
        rows={rows}
        today="2026-10-10"
        onComplete={() => {}}
        onOpenMeeting={() => {}}
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

describe("Today's review row", () => {
  it("counts a space's add and file cards and opens Review on that source and space", async () => {
    const g = group({})
    const html = await render([
      { kind: 'review', key: `review:${g.key}`, weight: g.total, group: g },
    ])
    expect(html).toContain('Proptech / Property ops')
    expect(html).toContain('via Exa · 3 to add · 1 to file')
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
      { kind: 'review', key: `review:${g.key}`, weight: g.total, group: g },
    ])
    expect(html).toContain('via Judgment · 2 to review')
    expect(html).toContain('href="/review?source=judgment"')
    expect(html).not.toContain('space=')
  })

  it('draws a past meeting nobody wrote up as a meeting row with Write', async () => {
    const html = await render([
      {
        kind: 'meeting',
        key: 'meeting:m1',
        weight: 2,
        id: 'm1',
        title: 'Flent intro',
        record: 'Flent',
        age: '2d',
      },
    ])
    expect(html).toMatch(/w-12[^>]*>meeting</)
    expect(html).toContain('Flent intro')
    expect(html).toMatch(/>Flent</)
    expect(html).toMatch(/<button[^>]*>Write<\/button>/)
    expect(html).toContain('>2d<')
  })
})
