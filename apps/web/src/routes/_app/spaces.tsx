import { createFileRoute } from '@tanstack/react-router'
import { SpacesIndexPage } from '#/components/spaces-index'
import { getSpacesIndex } from '#/lib/server-fns'

export const Route = createFileRoute('/_app/spaces')({
  loader: () => getSpacesIndex(),
  component: SpacesPage,
})

function SpacesPage() {
  return <SpacesIndexPage index={Route.useLoaderData()} />
}
