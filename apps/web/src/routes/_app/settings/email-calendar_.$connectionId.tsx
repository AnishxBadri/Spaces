import { createFileRoute } from '@tanstack/react-router'
import { AccountSection } from '#/components/settings/accounts-section'
import { accountOf, mailRowOf } from '#/lib/connections/accounts'
import { getMailboxSync, getMyAccounts } from '#/lib/server-fns'

/**
 * One mail or calendar account's page (`Options ›`), inside the settings
 * shell so Email & calendar stays lit; the `_` keeps it out of the list's
 * component.
 */
export const Route = createFileRoute(
  '/_app/settings/email-calendar_/$connectionId',
)({
  loader: async ({ params }) => {
    const view = await getMyAccounts()
    const row = view.connections.find(
      (r) => r.connectionId === params.connectionId,
    )
    const mailRow =
      row === undefined
        ? null
        : mailRowOf(accountOf(row, 'email-calendar', view.connections))
    const mail =
      mailRow === null
        ? null
        : await getMailboxSync({
            data: { connectionId: mailRow.connectionId },
          }).then((sync) =>
            sync === null
              ? null
              : { connectionId: mailRow.connectionId, view: sync },
          )
    return { view, mail }
  },
  component: EmailCalendarAccountRoute,
})

function EmailCalendarAccountRoute() {
  const { view, mail } = Route.useLoaderData()
  const { connectionId } = Route.useParams()
  return (
    <AccountSection
      job="email-calendar"
      connectionId={connectionId}
      view={view}
      mail={mail}
    />
  )
}
