import { createFileRoute } from '@tanstack/react-router'
import { ArrivalSection } from '#/components/settings/arrival-section'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { getMailboxSettings, getSession } from '#/lib/server-fns'

/**
 * Settings → Arrival (SPA-56) — the forwarding mailbox, a child route of the
 * settings shell like every section. Admin-only: the loader asks for the
 * mailbox only when the reader is an admin, since the server fns refuse
 * anyone else, and a member who types the URL reads a sentence instead of an
 * error. Loading the page never connects to the mail server; only Test
 * connection does.
 */
export const Route = createFileRoute('/_app/settings/arrival')({
  loader: async () => {
    const session = await getSession()
    if (session?.user.role !== 'admin') return { settings: null }
    return { settings: await getMailboxSettings() }
  },
  component: ArrivalRoute,
})

function ArrivalRoute() {
  const { settings } = Route.useLoaderData()
  if (settings) return <ArrivalSection settings={settings} />
  return (
    <SettingsSection
      title="Arrival"
      blurb="An address you forward or BCC mail to."
      crumb="Data & AI"
    >
      <SettingsRow
        label="Admins only"
        hint="The forwarding mailbox and its app password belong to the workspace admin."
      />
    </SettingsSection>
  )
}
