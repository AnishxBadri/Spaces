import { createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'
import { ProviderPage } from '#/components/settings/provider-page'
import { isProviderId } from '@spaces/core/providers/registry'
import { PROVIDER_TABS, defaultTab } from '#/lib/connections/provider-view'
import { getProviderPage } from '#/lib/server-fns'

/**
 * One provider's page (Google, Box), inside the settings shell so
 * Connections stays lit; the `_` keeps it out of the list's component.
 * `?tab=` picks Set up or In use; with none it opens on In use once the
 * client is active, Set up before. An unknown provider is not found.
 */
export const Route = createFileRoute('/_app/settings/connections_/$provider')({
  validateSearch: z.object({ tab: z.enum(PROVIDER_TABS).optional() }),
  loader: async ({ params }) => {
    const provider = params.provider
    if (!isProviderId(provider)) throw notFound()
    return { view: await getProviderPage({ data: { provider } }) }
  },
  component: ProviderRoute,
})

function ProviderRoute() {
  const { view } = Route.useLoaderData()
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <ProviderPage
      key={view.app.provider}
      view={view}
      tab={tab ?? defaultTab(view.app.configured)}
      onTab={(next) => void navigate({ search: { tab: next }, replace: true })}
    />
  )
}
