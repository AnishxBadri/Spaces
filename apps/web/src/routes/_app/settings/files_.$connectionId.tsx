import { createFileRoute } from '@tanstack/react-router'
import { AccountSection } from '#/components/settings/accounts-section'
import { getAccountBindings, getMyAccounts } from '#/lib/server-fns'

/**
 * One storage account's page (`Options ›`), inside the settings shell so
 * Files stays lit; the `_` keeps it out of the list's component. Its bound
 * folders and waiting exports load with it.
 */
export const Route = createFileRoute('/_app/settings/files_/$connectionId')({
  loader: async ({ params }) => {
    const [view, bindings] = await Promise.all([
      getMyAccounts(),
      getAccountBindings({ data: { connectionId: params.connectionId } }),
    ])
    return { view, bindings }
  },
  component: FilesAccountRoute,
})

function FilesAccountRoute() {
  const { view, bindings } = Route.useLoaderData()
  const { connectionId } = Route.useParams()
  return (
    <AccountSection
      job="files"
      connectionId={connectionId}
      view={view}
      bindings={bindings}
    />
  )
}
