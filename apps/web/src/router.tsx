import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { RecordGone, RecordLoadFailed } from '#/components/record/record-parts'

import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { getContext } from './integrations/tanstack-query/root-provider'

export function getRouter() {
  const context = getContext()

  const router = createTanStackRouter({
    routeTree,
    context,
    scrollRestoration: true,
    // A record pane's own scrollers start at the top on a new page rather
    // than inheriting the last page's offsets by DOM path; Back still
    // restores them. A tab switch passes `resetScroll: false` and leaves the
    // folder to `useFolderScroll`.
    scrollToTopSelectors: ['[data-folder-scroll]', '[data-record-rail]'],
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // Every route that names no screens of its own: a path or a record that
    // is not there, and a load that failed, each back to Today.
    defaultNotFoundComponent: () => <RecordGone />,
    defaultErrorComponent: ({ error }) => <RecordLoadFailed error={error} />,
  })

  setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
