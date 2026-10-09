import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
import { Route as TodayRoute } from '#/routes/_app/today'

/**
 * Today with no company (D80): the P5 block's three ways in and no other
 * section — no day strip, no readouts, no ledger, no rail. The company
 * count that switches it off is `companyCountProgram`'s test.
 */

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
    loader: () => ({ empty: true, registry: [] }),
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

describe('Today in an empty workspace', () => {
  it('offers the three ways in and nothing else', async () => {
    const html = await renderToday()
    expect(html).toContain('Bring in what you already have.')
    expect(html).toContain('href="/import"')
    expect(html).toContain('Import a file')
    expect(html).toContain('CSV or Airtable export')
    expect(html).toContain('Drop a deck')
    expect(html).toContain('Add a company')
    for (const absent of [
      'Needs you',
      'Overdue',
      'Portfolio',
      "What's moving",
      'Getting started',
    ])
      expect(html).not.toContain(absent)
  })
})
