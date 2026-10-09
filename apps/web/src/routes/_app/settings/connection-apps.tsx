import { createFileRoute } from '@tanstack/react-router'
import { ConnectionAppsSection } from '#/components/settings/connection-apps-section'
import { getProviderApps } from '#/lib/server-fns'

/**
 * Settings → Connection apps — the providers' OAuth clients. A member reads
 * them too, each secret redacted and every control disabled. (D81)
 */
export const Route = createFileRoute('/_app/settings/connection-apps')({
  loader: async () => ({ apps: await getProviderApps() }),
  component: ConnectionAppsRoute,
})

function ConnectionAppsRoute() {
  const { apps } = Route.useLoaderData()
  return <ConnectionAppsSection apps={apps} />
}
