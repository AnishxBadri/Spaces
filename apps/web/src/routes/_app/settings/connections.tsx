import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsList } from '#/components/settings/connections-list'
import { getConnections } from '#/lib/server-fns'

/**
 * Settings → Integrations → Connections: one row per provider, each opening
 * its page. A member reads it too.
 */
export const Route = createFileRoute('/_app/settings/connections')({
  loader: async () => ({ rows: await getConnections() }),
  component: ConnectionsRoute,
})

function ConnectionsRoute() {
  const { rows } = Route.useLoaderData()
  return <ConnectionsList rows={rows} />
}
