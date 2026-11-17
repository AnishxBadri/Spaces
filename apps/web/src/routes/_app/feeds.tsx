import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { FeedWindow } from '#/components/feeds/feed-window'
import { FeedsHeadLine } from '#/components/feeds/feeds-head-line'
import type { FeedsTab } from '#/components/feeds/feeds-head-line'
import type { FeedWindowMode } from '#/components/feeds/feed-window'
import {
  HEADLINES_STEP,
  filterSpaces,
  removeBody,
} from '#/components/feeds/feed-words'
import type { SpaceOption } from '#/components/feeds/feed-words'
import { HeadlinesPane } from '#/components/feeds/headlines'
import { SourcesTable } from '#/components/feeds/sources-table'
import { SpaceFilter } from '#/components/feeds/space-filter'
import { icon } from '#/components/icons'
import {
  Card,
  FolderGround,
  ListPage,
  PageBody,
  PageHeader,
} from '#/components/page-header'
import { ListErrorRow } from '#/components/table/list-states'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { TabDivider, Tabs } from '#/components/ui/tabs'
import { spacePathLabel } from '#/lib/file-in-space'
import {
  listFeedSources,
  listHeadlines,
  listSpaces,
  removeFeed,
} from '#/lib/server-fns'
import type { FeedSource } from '#/lib/server-fns'

/**
 * `/feeds` — the workspace's feeds: the Headlines tab and the Sources tab,
 * whose table is every feed with its state. The open tab is `?tab=`, so a
 * reload, back and a link land on the same one; Headlines is the default.
 * - The sources are a query seeded by the loader. While a feed waits on its
 *   first fetch the query reads again every few seconds, so its Latest fills
 *   in without a reload; otherwise once a minute, which is how a feed that
 *   starts failing marks the tab.
 * - Headlines' space filter sits on the tab bar after the tabs; the space
 *   is `?space=`, so a reload keeps it. It is a loader dep: page one of the
 *   narrowed list comes with the load, and a failed read leaves it to the
 *   tab, which says so and retries.
 * - Below `md` the head has no folder bar and no button: one mono line on
 *   the title's baseline (`FeedsHeadLine`) holds the tabs, the same space
 *   filter and Add feed, and the body takes the gutter's top back.
 */

type FeedsSearch = {
  tab?: FeedsTab | undefined
  /** The space Headlines is narrowed to; absent is every space. */
  space?: string | undefined
}

const SPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only `sources` is spelled in the URL; anything else is the default tab. */
const feedsSearch = (raw: Record<string, unknown>): FeedsSearch => ({
  ...(raw.tab === 'sources' ? { tab: 'sources' as const } : {}),
  ...(typeof raw.space === 'string' && SPACE_ID.test(raw.space)
    ? { space: raw.space }
    : {}),
})

export const Route = createFileRoute('/_app/feeds')({
  validateSearch: feedsSearch,
  loaderDeps: ({ search }) => ({ space: search.space ?? null }),
  loader: async ({ deps }) => {
    const [sources, spaces, page] = await Promise.all([
      listFeedSources(),
      listSpaces(),
      listHeadlines({
        data: {
          limit: HEADLINES_STEP,
          ...(deps.space === null ? {} : { spaceId: deps.space }),
        },
      }).catch(() => null),
    ])
    return { sources, spaces, headlines: { space: deps.space, page } }
  },
  component: FeedsPage,
})

const FEED_SOURCES_QUERY = ['feed-sources']

/** While a feed is waiting on its first fetch. */
const FIRST_FETCH_POLL_MS = 3_000
/** Otherwise: a failing feed marks the tab within a minute of failing. */
const SOURCES_POLL_MS = 60_000

function FeedsPage() {
  const loaded = Route.useLoaderData()
  const { tab = 'headlines', space = null } = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const [windowMode, setWindowMode] = useState<FeedWindowMode | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const query = useQuery({
    queryKey: FEED_SOURCES_QUERY,
    queryFn: () => listFeedSources(),
    initialData: loaded.sources,
    staleTime: FIRST_FETCH_POLL_MS,
    refetchInterval: (q) =>
      q.state.data?.some((s) => s.state === 'new') === true
        ? FIRST_FETCH_POLL_MS
        : SOURCES_POLL_MS,
  })
  const sources = query.data

  const spaces = useMemo((): Array<SpaceOption> => {
    const byId = new Map(loaded.spaces.map((s) => [s.id, s]))
    return loaded.spaces.map((s) => ({
      id: s.id,
      path: spacePathLabel(s, byId),
    }))
  }, [loaded.spaces])
  const pathOf = useMemo(
    () => new Map(spaces.map((s) => [s.id, s.path])),
    [spaces],
  )
  const parentOf = useMemo(
    () => new Map(loaded.spaces.map((s) => [s.id, s.parentId])),
    [loaded.spaces],
  )
  const tagged = useMemo(() => filterSpaces(sources, pathOf), [sources, pathOf])

  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: FEED_SOURCES_QUERY }),
    [queryClient],
  )
  const setTab = useCallback(
    (next: FeedsTab) =>
      void navigate({
        search: (prev) => ({
          ...prev,
          tab: next === 'sources' ? 'sources' : undefined,
        }),
        replace: true,
      }),
    [navigate],
  )
  const setSpace = useCallback(
    (next: string | null) =>
      void navigate({
        search: (prev) => ({ ...prev, space: next ?? undefined }),
        replace: true,
      }),
    [navigate],
  )
  const openAdd = () => setWindowMode({ kind: 'add' })
  const onEdit = useCallback(
    (source: FeedSource) => setWindowMode({ kind: 'edit', source, fix: false }),
    [],
  )
  const onFix = useCallback(
    (source: FeedSource) => setWindowMode({ kind: 'edit', source, fix: true }),
    [],
  )
  const onRemove = useCallback(
    async (source: FeedSource) => {
      const ok = await confirm({
        title: `Remove ${source.name}?`,
        body: removeBody(source.headlineCount),
        action: 'Remove',
        note: "Can't be undone",
      })
      if (!ok) return
      try {
        await removeFeed({ data: { id: source.id } })
      } catch (err) {
        toast.error(
          err instanceof Error && err.message !== ''
            ? err.message
            : `Could not remove ${source.name}`,
        )
      }
      refresh()
    },
    [confirm, refresh],
  )

  const failing = sources.some((s) => s.state === 'failing')
  const scoped = tab === 'headlines' && (tagged.length > 0 || space !== null)
  const spaceFilter = (variant: 'bar' | 'line') => (
    <SpaceFilter
      value={space}
      spaces={tagged}
      pathOf={pathOf}
      onChange={setSpace}
      variant={variant}
    />
  )

  return (
    <ListPage>
      <PageHeader
        title="Feeds"
        folds={false}
        // Below `md` the line sits on the title's baseline, as the narrow
        // board draws it; from `md` the button keeps the head's top line.
        className="max-md:items-baseline"
        action={
          <>
            {sources.length === 0 ? null : (
              <FeedsHeadLine
                tab={tab}
                onTab={setTab}
                sourceCount={sources.length}
                failing={failing}
                onAdd={openAdd}
                {...(scoped ? { scope: spaceFilter('line') } : {})}
                className="md:hidden"
              />
            )}
            <Button onClick={openAdd} className="max-md:hidden">
              <icon.new aria-hidden className="size-4" />
              Add feed
            </Button>
          </>
        }
      />
      {sources.length === 0 ? (
        // First run: no feed yet — one row that adds one.
        <PageBody>
          <Card className="flex-1">
            <p
              data-list-state="no-feeds"
              className="flex h-ledger-row shrink-0 items-center gap-2.5 border-b border-rule px-3 text-ui"
            >
              <span className="text-graphite">No feeds yet.</span>
              <button
                type="button"
                onClick={openAdd}
                className="focus-ring rounded-md font-medium text-primary underline-offset-4 hover:underline"
              >
                Add a feed
              </button>
            </p>
          </Card>
        </PageBody>
      ) : (
        <>
          <FeedsTabs
            tab={tab}
            onTab={setTab}
            sourceCount={sources.length}
            failing={failing}
            trail={
              scoped ? (
                <>
                  <TabDivider />
                  {spaceFilter('bar')}
                </>
              ) : undefined
            }
          />
          {/* Below `md` there is no bar to join, so the body keeps the
              gutter above and the folder its top edge. */}
          <PageBody className="min-h-0 md:pt-0 max-md:[&>[data-folder]]:border-t max-md:[&>[data-frame=folder]]:border-t">
            {tab === 'sources' ? (
              <SourcesTable
                sources={sources}
                pathOf={pathOf}
                notice={
                  query.isError ? (
                    <ListErrorRow
                      plural="Sources"
                      onRetry={() => void query.refetch()}
                    />
                  ) : undefined
                }
                onEdit={onEdit}
                onFix={onFix}
                onRemove={(s) => void onRemove(s)}
              />
            ) : (
              <HeadlinesPane
                spaceId={space}
                initial={
                  loaded.headlines.space === space
                    ? loaded.headlines.page
                    : null
                }
                sources={sources}
                pathOf={pathOf}
                parentOf={parentOf}
                onAllSpaces={() => setSpace(null)}
              />
            )}
          </PageBody>
        </>
      )}
      <FeedWindow
        mode={windowMode}
        onOpenChange={(open) => {
          if (!open) setWindowMode(null)
        }}
        spaces={spaces}
        onSaved={() => {
          if (windowMode?.kind === 'add') setTab('sources')
          refresh()
        }}
        onRemove={(s) => void onRemove(s)}
      />
      {confirmDialog}
    </ListPage>
  )
}

/**
 * The page's folder bar, from `md` up: Headlines, then Sources with its
 * count and, while any feed is failing, the crimson square after it.
 * `trail` is the space filter's place beside the tabs.
 */
function FeedsTabs({
  tab,
  onTab,
  sourceCount,
  failing,
  trail,
}: {
  tab: FeedsTab
  onTab: (tab: FeedsTab) => void
  sourceCount: number
  failing: boolean
  trail?: ReactNode
}) {
  return (
    <FolderGround className="max-md:hidden">
      <Tabs
        label="Feeds"
        items={[
          // Ink when closed: the tab is a view, not a count.
          { id: 'headlines', label: 'Headlines', uncounted: true },
          {
            id: 'sources',
            label: 'Sources',
            count: sourceCount,
            suffix: failing ? (
              <span
                role="img"
                aria-label="A feed is failing"
                data-failing-mark
                className="size-1.5 shrink-0 bg-destructive"
              />
            ) : null,
          },
        ]}
        value={tab}
        onValueChange={onTab}
        flush
        {...(trail === undefined ? {} : { trail })}
      />
    </FolderGround>
  )
}
