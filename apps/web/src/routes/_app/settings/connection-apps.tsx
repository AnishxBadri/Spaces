import { createFileRoute } from '@tanstack/react-router'
import { ConnectionAppsSection } from '#/components/settings/connection-apps-section'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { getProviderApps, getSession } from '#/lib/server-fns'

/**
 * Settings → Connection apps — the providers' OAuth clients. Admin-only: the
 * loader asks for them only when the reader is an admin, since the server fn
 * refuses anyone else, and a member who types the URL reads a sentence
 * instead of an error.
 */
export const Route = createFileRoute('/_app/settings/connection-apps')({
  loader: async () => {
    const session = await getSession()
    if (session?.user.role !== 'admin') return { apps: null }
    return { apps: await getProviderApps() }
  },
  component: ConnectionAppsRoute,
})

function ConnectionAppsRoute() {
  const { apps } = Route.useLoaderData()
  if (apps) return <ConnectionAppsSection apps={apps} />
  return (
    <SettingsSection
      title="Connection apps"
      blurb="The OAuth clients members connect their accounts through."
      crumb="Integrations"
    >
      <SettingsRow
        label="Admins only"
        hint="The OAuth clients and their secrets belong to the workspace admin."
      />
    </SettingsSection>
  )
}
