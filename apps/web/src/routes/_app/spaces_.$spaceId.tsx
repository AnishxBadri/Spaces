import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { SpacePageView } from '#/components/space-page'
import { getEntitySensitivity, getSpace, listTerms } from '#/lib/server-fns'
import { rememberRecordTab, useLastRecordTab } from '#/lib/record-tab-pref'
import { openSpaceTab, spaceSearch } from '#/lib/spaces/page'
import type { SpaceTab } from '#/lib/spaces/page'

/**
 * A space's page. `?tab=` deep-links a tab; without one the space opens on
 * the tab last used on any space, else Notes. (D74)
 */
export const Route = createFileRoute('/_app/spaces_/$spaceId')({
  validateSearch: spaceSearch,
  loader: async ({ params }) => {
    const [spc, terms, sensitivity] = await Promise.all([
      getSpace({ data: { id: params.spaceId } }),
      listTerms({ data: { spaceId: params.spaceId } }),
      getEntitySensitivity({ data: { entityId: params.spaceId } }),
    ])
    return { spc, terms, sensitivity }
  },
  component: SpacePage,
})

/** The tab memory's key: one last tab for every space. */
const TAB_PREF = 'space'

function SpacePage() {
  const { spc, terms, sensitivity } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const tab = openSpaceTab(search.tab, useLastRecordTab(TAB_PREF))

  function changeTab(next: SpaceTab) {
    rememberRecordTab(TAB_PREF, next)
    void navigate({
      to: '/spaces/$spaceId',
      params: { spaceId: spc.id },
      search: { tab: next },
      replace: true,
      resetScroll: false,
    })
  }

  return (
    <SpacePageView
      spc={spc}
      terms={terms}
      sensitivity={sensitivity}
      tab={tab}
      onTabChange={changeTab}
    />
  )
}
