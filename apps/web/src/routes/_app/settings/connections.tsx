import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsSection } from '#/components/settings/connections-section'
import {
  getConfiguredProviders,
  getProviderApps,
  getSession,
  listMyConnections,
} from '#/lib/server-fns'

/**
 * Settings → Connections — the reader's own connections and the providers
 * they can connect to, and for an admin the providers' OAuth clients. The
 * loader asks for the clients only when the reader is an admin, since the
 * server fn refuses anyone else.
 */
export const Route = createFileRoute('/_app/settings/connections')({
  loader: async () => {
    const [session, configured, connections] = await Promise.all([
      getSession(),
      getConfiguredProviders(),
      listMyConnections(),
    ])
    if (session?.user.role !== 'admin')
      return { apps: null, configured, connections }
    return { apps: await getProviderApps(), configured, connections }
  },
  component: ConnectionsRoute,
})

function ConnectionsRoute() {
  const { apps, configured, connections } = Route.useLoaderData()
  return (
    <ConnectionsSection
      apps={apps}
      configured={configured}
      connections={connections}
    />
  )
}
