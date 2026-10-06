import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsSection } from '#/components/settings/connections-section'
import {
  getConfiguredProviders,
  getProviderApps,
  getSession,
} from '#/lib/server-fns'

/**
 * Settings → Connections — each member's own connections and the providers
 * they can connect to, and for an admin the providers' OAuth clients. The
 * loader asks for the clients only when the reader is an admin, since the
 * server fns refuse anyone else.
 */
export const Route = createFileRoute('/_app/settings/connections')({
  loader: async () => {
    const [session, configured] = await Promise.all([
      getSession(),
      getConfiguredProviders(),
    ])
    if (session?.user.role !== 'admin') return { apps: null, configured }
    return { apps: await getProviderApps(), configured }
  },
  component: ConnectionsRoute,
})

function ConnectionsRoute() {
  const { apps, configured } = Route.useLoaderData()
  return <ConnectionsSection apps={apps} configured={configured} />
}
