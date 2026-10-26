import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { SpacePageView } from '#/components/space-page'
import {
  getEntitySensitivity,
  getSpace,
  getSpaceWatching,
  listTerms,
} from '#/lib/server-fns'
import { DEFAULT_SPACE_TAB, spaceSearch } from '#/lib/spaces/page'
import type { SpaceTab } from '#/lib/spaces/page'

/**
 * A space's page. It opens on Overview unless `?tab=` deep-links another
 * tab. `?into=` opens Companies selecting into that subspace, where a split
 * lands. `?watch=` marks a watch in the Watching lane.
 */
export const Route = createFileRoute('/_app/spaces_/$spaceId')({
  validateSearch: spaceSearch,
  loader: async ({ params }) => {
    const [spc, terms, sensitivity, watching] = await Promise.all([
      getSpace({ data: { id: params.spaceId } }),
      listTerms({ data: { spaceId: params.spaceId } }),
      getEntitySensitivity({ data: { entityId: params.spaceId } }),
      getSpaceWatching({ data: { spaceId: params.spaceId } }),
    ])
    return { spc, terms, sensitivity, watching }
  },
  component: SpacePage,
})

function SpacePage() {
  const { spc, terms, sensitivity, watching } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const tab = search.tab ?? DEFAULT_SPACE_TAB

  function changeTab(next: SpaceTab) {
    void navigate({
      to: '/spaces/$spaceId',
      params: { spaceId: spc.id },
      search: next === DEFAULT_SPACE_TAB ? {} : { tab: next },
      replace: true,
      resetScroll: false,
    })
  }

  return (
    <SpacePageView
      spc={spc}
      terms={terms}
      sensitivity={sensitivity}
      watching={watching}
      tab={tab}
      into={search.into ?? null}
      markedWatch={search.watch ?? null}
      onTabChange={changeTab}
    />
  )
}
