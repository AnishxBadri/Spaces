import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsSection } from '#/components/settings/connections-section'
import {
  getConfiguredProviders,
  getSession,
  listMyConnections,
} from '#/lib/server-fns'

/**
 * Settings → Connections — the reader's own connections and the providers
 * they can connect to. The OAuth clients are Connection apps'.
 */
export const Route = createFileRoute('/_app/settings/connections')({
  loader: async () => {
    const [session, configured, connections] = await Promise.all([
      getSession(),
      getConfiguredProviders(),
      listMyConnections(),
    ])
    return {
      isAdmin: session?.user.role === 'admin',
      configured,
      connections,
    }
  },
  component: ConnectionsRoute,
})

function ConnectionsRoute() {
  const { isAdmin, configured, connections } = Route.useLoaderData()
  return (
    <ConnectionsSection
      isAdmin={isAdmin}
      configured={configured}
      connections={connections}
    />
  )
}
