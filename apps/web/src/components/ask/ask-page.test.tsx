import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClockProvider } from '#/components/clock'
import type { AskThreadRow } from '#/lib/server-fns'
import { Route } from '#/routes/_app/ask'

/**
 * `/ask`'s thread list, rendered as the server ships it under a memory
 * router whose ids mirror the app's: with no thread yet it is its head
 * alone, never a sentence saying so.
 */

const NOW = '2026-10-15T09:00:00.000Z'

async function render(rows: Array<AskThreadRow>): Promise<string> {
  const rootRoute = createRootRoute()
  const app = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    component: () => <Outlet />,
  })
  const { component, validateSearch } = Route.options
  const ask = createRoute({
    getParentRoute: () => app,
    path: 'ask',
    loader: () => rows,
    ...(component === undefined ? {} : { component }),
    ...(validateSearch === undefined ? {} : { validateSearch }),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([ask])]),
    history: createMemoryHistory({ initialEntries: ['/ask'] }),
  })
  await router.load()
  return renderToStaticMarkup(
    <ClockProvider now={NOW}>
      <RouterProvider router={router} />
    </ClockProvider>,
  )
}

describe('the Ask thread list', () => {
  it('is its head alone with no thread: no absence sentence', async () => {
    const html = await render([])
    expect(html).toContain('aria-label="Threads"')
    expect(html).toContain('>Threads</h1>')
    expect(html).not.toContain('No threads')
  })
})
