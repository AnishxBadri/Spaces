import { createFileRoute } from '@tanstack/react-router'
import { AccountsSection } from '#/components/settings/accounts-section'
import { getMailboxSettings, getMyAccounts } from '#/lib/server-fns'

/**
 * Settings → You → Email & calendar: the reader's mail and calendar
 * accounts, the Default one new email sends from, Connect per provider, and
 * the workspace's Bcc address. (D81)
 */
export const Route = createFileRoute('/_app/settings/email-calendar')({
  loader: async () => {
    const [view, mailbox] = await Promise.all([
      getMyAccounts(),
      getMailboxSettings(),
    ])
    return { view, address: mailbox.mailbox?.address ?? null }
  },
  component: EmailCalendarRoute,
})

function EmailCalendarRoute() {
  const { view, address } = Route.useLoaderData()
  return (
    <AccountsSection
      job="email-calendar"
      view={view}
      forwarding={{ address }}
    />
  )
}
