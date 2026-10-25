import { createFileRoute } from '@tanstack/react-router'
import { ArrivalSection } from '#/components/settings/arrival-section'
import { getMailboxSettings } from '#/lib/server-fns'

/**
 * Settings → Integrations → Email forwarding: the forwarding mailbox.
 * - A member reads it too, the app password redacted and every control
 *   disabled.
 * - Loading the page never connects to the mail server; only Test
 *   connection does.
 */
export const Route = createFileRoute('/_app/settings/email-forwarding')({
  loader: async () => ({ settings: await getMailboxSettings() }),
  component: ArrivalRoute,
})

function ArrivalRoute() {
  const { settings } = Route.useLoaderData()
  return <ArrivalSection settings={settings} />
}
