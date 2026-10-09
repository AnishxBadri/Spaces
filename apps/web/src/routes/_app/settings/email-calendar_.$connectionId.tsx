import { createFileRoute } from '@tanstack/react-router'
import { AccountSection } from '#/components/settings/accounts-section'
import { getMyAccounts } from '#/lib/server-fns'

/**
 * One mail or calendar account's page (`Options ›`), inside the settings
 * shell so Email & calendar stays lit; the `_` keeps it out of the list's
 * component.
 */
export const Route = createFileRoute(
  '/_app/settings/email-calendar_/$connectionId',
)({
  loader: async () => ({ view: await getMyAccounts() }),
  component: EmailCalendarAccountRoute,
})

function EmailCalendarAccountRoute() {
  const { view } = Route.useLoaderData()
  const { connectionId } = Route.useParams()
  return (
    <AccountSection
      job="email-calendar"
      connectionId={connectionId}
      view={view}
    />
  )
}
