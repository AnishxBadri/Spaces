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
 * Today's review row (D79): a space's open discovery cards as one row,
 * "Proptech / Property ops · via Exa · 3 to add · 1 to file", linking to
 * Review filtered by that space.
 */

// The composer reads the session from the app route; it is not under test.
vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))

const SPACE = '00000000-0000-4000-8000-000000000001'

const group = (over: Partial<ReviewGroup>): ReviewGroup => ({
  key: `Exa|${SPACE}|discovery`,
  spaceId: SPACE,
  spaceLabel: 'Proptech / Property ops',
  source: 'Exa',
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
  it("counts a space's add and file cards and opens Review on that space", async () => {
    const g = group({})
    const html = await render([
      { kind: 'review', key: `review:${g.key}`, weight: g.total, group: g },
    ])
    expect(html).toContain('Proptech / Property ops')
    expect(html).toContain('via Exa · 3 to add · 1 to file')
    expect(html).toContain(`href="/review?record=${SPACE}"`)
  })

  it('opens the whole queue for a row of other cards', async () => {
    const g = group({
      key: `Judgment|${SPACE}`,
      source: 'Judgment',
      toAdd: 0,
      toFile: 0,
      toReview: 2,
      total: 2,
    })
    const html = await render([
      { kind: 'review', key: `review:${g.key}`, weight: g.total, group: g },
    ])
    expect(html).toContain('via Judgment · 2 to review')
    expect(html).toContain('href="/review"')
    expect(html).not.toContain('record=')
  })
})
