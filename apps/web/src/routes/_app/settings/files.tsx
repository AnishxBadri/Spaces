import { createFileRoute } from '@tanstack/react-router'
import { AccountsSection } from '#/components/settings/accounts-section'
import { getMyAccounts } from '#/lib/server-fns'

/**
 * Settings → You → Files: the reader's storage accounts, several allowed,
 * each with its sync state. Which folder belongs to which space stays on
 * the space.
 */
export const Route = createFileRoute('/_app/settings/files')({
  loader: async () => ({ view: await getMyAccounts() }),
  component: FilesRoute,
})

function FilesRoute() {
  const { view } = Route.useLoaderData()
  return <AccountsSection job="files" view={view} />
}
