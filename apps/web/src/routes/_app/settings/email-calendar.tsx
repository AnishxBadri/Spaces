import { createFileRoute } from '@tanstack/react-router'
import { AccountsSection } from '#/components/settings/accounts-section'
import {
  getEmailSignature,
  getMailboxSettings,
  getMyAccounts,
} from '#/lib/server-fns'

/**
 * Settings → You → Email & calendar: the reader's mail and calendar
 * accounts, the Default one new email sends from, Connect per provider, the
 * workspace's Bcc address, and the reader's own email signature, which
 * needs no account connected.
 */
export const Route = createFileRoute('/_app/settings/email-calendar')({
  loader: async () => {
    const [view, mailbox, signature] = await Promise.all([
      getMyAccounts(),
      getMailboxSettings(),
      getEmailSignature(),
    ])
    return { view, address: mailbox.mailbox?.address ?? null, signature }
  },
  component: EmailCalendarRoute,
})

function EmailCalendarRoute() {
  const { view, address, signature } = Route.useLoaderData()
  return (
    <AccountsSection
      job="email-calendar"
      view={view}
      forwarding={{ address }}
      signature={signature}
    />
  )
}
