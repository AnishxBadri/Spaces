import { createFileRoute } from '@tanstack/react-router'
import { AccountSection } from '#/components/settings/accounts-section'
import { getMyAccounts } from '#/lib/server-fns'

/**
 * One storage account's page (`Options ›`), inside the settings shell so
 * Files stays lit; the `_` keeps it out of the list's component.
 */
export const Route = createFileRoute('/_app/settings/files_/$connectionId')({
  loader: async () => ({ view: await getMyAccounts() }),
  component: FilesAccountRoute,
})

function FilesAccountRoute() {
  const { view } = Route.useLoaderData()
  const { connectionId } = Route.useParams()
  return <AccountSection job="files" connectionId={connectionId} view={view} />
}
