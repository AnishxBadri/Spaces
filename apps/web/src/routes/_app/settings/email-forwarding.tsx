import { createFileRoute } from '@tanstack/react-router'
import { ArrivalSection } from '#/components/settings/arrival-section'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { getMailboxSettings, getSession } from '#/lib/server-fns'

/**
 * Settings → Integrations → Email forwarding: the forwarding mailbox. (D81)
 * - Admin-only: the loader asks only when the reader is an admin; a member
 *   who types the URL reads a sentence instead of an error.
 * - Loading the page never connects to the mail server; only Test
 *   connection does.
 */
export const Route = createFileRoute('/_app/settings/email-forwarding')({
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
      title="Email forwarding"
      blurb="An address you forward or BCC mail to."
      crumb="Integrations"
    >
      <SettingsRow
        label="Admins only"
        hint="The forwarding mailbox and its app password belong to the workspace admin."
      />
    </SettingsSection>
  )
}
