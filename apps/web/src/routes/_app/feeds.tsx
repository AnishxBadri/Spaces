import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { FeedWindow } from '#/components/feeds/feed-window'
import type { FeedWindowMode } from '#/components/feeds/feed-window'
import { removeBody } from '#/components/feeds/feed-words'
import type { SpaceOption } from '#/components/feeds/feed-words'
import { SourcesTable } from '#/components/feeds/sources-table'
import { icon } from '#/components/icons'
import { EmptyRow } from '#/components/ledger-section'
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
import { FolderBody, Tabs } from '#/components/ui/tabs'
import { spacePathLabel } from '#/lib/file-in-space'
import { listFeedSources, listSpaces, removeFeed } from '#/lib/server-fns'
import type { FeedSource } from '#/lib/server-fns'

/**
 * `/feeds` — the workspace's feeds: the Headlines tab and the Sources tab,
 * whose table is every feed with its state. The open tab is `?tab=`, so a
 * reload, back and a link land on the same one; Headlines is the default.
 * - The sources are a query seeded by the loader. While a feed waits on its
 *   first fetch the query reads again every few seconds, so its Latest fills
 *   in without a reload; otherwise once a minute, which is how a feed that
 *   starts failing marks the tab.
 * - The tab bar takes a `trail` for the space filter beside the tabs.
 */

type FeedsTab = 'headlines' | 'sources'

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
  loader: async () => {
    const [sources, spaces] = await Promise.all([
      listFeedSources(),
      listSpaces(),
    ])
    return { sources, spaces }
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
  const { tab = 'headlines' } = Route.useSearch()
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

  return (
    <ListPage>
      <PageHeader
        title="Feeds"
        folds={false}
        action={
          <Button onClick={openAdd}>
            <icon.new aria-hidden className="size-4" strokeWidth={2} />
            Add feed
          </Button>
        }
      />
      {sources.length === 0 ? (
        // First run: no feed yet — one row that adds one.
        <PageBody>
          <Card>
            <EmptyRow name="Feeds" onAdd={openAdd} />
          </Card>
        </PageBody>
      ) : (
        <>
          <FeedsTabs
            tab={tab}
            onTab={setTab}
            sourceCount={sources.length}
            failing={failing}
          />
          <PageBody className="min-h-0 pt-0">
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
              <HeadlinesBody />
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
 * The page's folder bar: Headlines, then Sources with its count and, while
 * any feed is failing, the crimson square after it. `trail` is the space
 * filter's place beside the tabs.
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
    <FolderGround>
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

/** The Headlines tab's body until the list and the reader land. */
function HeadlinesBody() {
  return (
    <FolderBody label="Headlines" className="flex-1">
      <p className="px-(--inset) py-6 font-serif text-body text-graphite">
        No headlines yet.
      </p>
    </FolderBody>
  )
}
