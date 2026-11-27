import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useOpenFile } from '#/components/files/file-window-nav'
import {
  FilesArrange,
  FilesFilter,
  filesAppliedFilters,
} from '#/components/files/files-filters'
import { FilesDrop } from '#/components/files/files-drop'
import { FilesLedger } from '#/components/files/files-ledger'
import { FilesToolbar } from '#/components/files/files-toolbar'
import { UploadButton } from '#/components/files/upload-menu'
import { EmptyRow } from '#/components/ledger-section'
import { FilterChips } from '#/components/list/filter-chips'
import { Card, ListPage, PageBody, PageHeader } from '#/components/page-header'
import { listFiles } from '#/lib/server-fns'
import {
  chooseFilesToAdd,
  dismissArrival,
  useArrivals,
  useLandings,
} from '#/lib/documents/arrivals'
import type { Arrival } from '#/lib/documents/arrivals'
import { filesSearch } from '#/lib/documents/to-files'
import {
  NO_FILTERS,
  addressOf,
  filtersOf,
  filtersOn,
} from '#/lib/documents/files-filter'
import type {
  FilesFilters,
  FilesGroup,
  FilesSort,
} from '#/lib/documents/files-filter'
import type { FilesLedgerRow } from '#/lib/documents/files-ledger'
import type { FilesTab } from '#/lib/documents/files-ledger-view'

/** Rows a page of the list holds, and what `Load n more` adds. */
const FILES_STEP = 50

/** The most rows the address may ask for at once. */
const FILES_MAX = 1000

/** The open tab: `All` when the address names no kind. */
const tabOf = (tab: Exclude<FilesTab, 'all'> | undefined): FilesTab =>
  tab ?? 'all'

/**
 * `/files`: every file the reader may read, as a ledger. The page is Files;
 * the rows are `document`s, and every code name keeps that word.
 * - The folder tabs are the kinds; `Unfiled` is the first band, then the
 *   date bands. A fixed pane: the head, the tab bar and the foot stay while
 *   the rows scroll inside the folder.
 * - The address holds the tab (`?tab=deck`), the search (`?q=`), the
 *   filters (`?from=email&under=<id>`), the grouping and the sort
 *   (`?group=record&sort=name`) and how many rows are shown (`?n=100`), so
 *   reload, Back and a link land on the same list; `loaderDeps` re-runs
 *   the loader when any changes.
 * - A row opens the file's window over the list (`?modal=file&id=`), at
 *   the page a search hit names (`&page=5`).
 * - Files dropped anywhere on the page, or chosen from `Upload`, land at
 *   once as rows in `Unfiled` (`FilesDrop`, `addFiles`); no dialog.
 */
export const Route = createFileRoute('/_app/files')({
  validateSearch: filesSearch,
  loaderDeps: ({ search }) => ({
    tab: tabOf(search.tab),
    q: search.q ?? '',
    n: Math.min(search.n ?? FILES_STEP, FILES_MAX),
    under: search.under,
    from: search.from,
    type: search.type,
    by: search.by,
    look: search.look,
    group: search.group ?? 'date',
    sort: search.sort ?? 'newest',
  }),
  loader: ({ deps }) =>
    listFiles({
      data: {
        tab: deps.tab,
        q: deps.q,
        limit: deps.n,
        filters: filtersOf(deps),
        group: deps.group,
        sort: deps.sort,
      },
    }),
  component: FilesPage,
})

function FilesPage() {
  // The page's title and the open tab name the list to a screen reader.
  const titleId = useId()
  const tabId = useId()
  const ledger = Route.useLoaderData()
  const search = Route.useSearch()
  const { tab = 'all', q = '', group = 'date', sort = 'newest' } = search
  const { under, from, type, by, look } = search
  // One object per address, so the panel's counts read once per change.
  const filters = useMemo(
    () => filtersOf({ under, from, type, by, look }),
    [under, from, type, by, look],
  )
  const navigate = Route.useNavigate()
  const openFile = useOpenFile()
  const [loading, setLoading] = useState(false)
  const arrivals = useArrivals()
  useSettleArrivals(arrivals)
  useReadPolling(ledger.rows, useLandings())

  const go = (patch: {
    tab?: Exclude<FilesTab, 'all'> | undefined
    q?: string | undefined
    n?: number | undefined
  }) =>
    navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
      resetScroll: false,
    })
  // A filter or an arrangement is its own history step, so Back undoes it.
  const filterBy = (next: FilesFilters) =>
    navigate({
      search: (prev) => ({ ...prev, ...addressOf(next), n: undefined }),
      resetScroll: false,
    })
  const arrange = (patch: {
    group?: FilesGroup | undefined
    sort?: FilesSort | undefined
  }) =>
    navigate({
      search: (prev) => ({ ...prev, ...patch, n: undefined }),
      resetScroll: false,
    })
  const found =
    q === ''
      ? undefined
      : [
          `${ledger.total.toLocaleString('en-US')} ${ledger.total === 1 ? 'file' : 'files'}`,
          ...(ledger.places > 0
            ? [
                `${ledger.places.toLocaleString('en-US')} ${ledger.places === 1 ? 'place' : 'places'}`,
              ]
            : []),
        ].join(' · ')

  return (
    <ListPage>
      <FilesDrop
        head={
          <PageHeader
            title="Files"
            titleId={titleId}
            index
            action={<UploadButton />}
          />
        }
      >
        {ledger.counts.all === 0 &&
        filtersOn(filters) === 0 &&
        arrivals.length === 0 ? (
          // First run: nothing here — one row that uploads.
          <PageBody>
            <Card>
              <EmptyRow name="Files" onAdd={chooseFilesToAdd} />
            </Card>
          </PageBody>
        ) : (
          <>
            <FilesToolbar
              tab={tab}
              counts={ledger.counts}
              onTabChange={(t) =>
                void go({ tab: t === 'all' ? undefined : t, n: undefined })
              }
              q={q}
              onSearch={(text) =>
                void go({ q: text === '' ? undefined : text, n: undefined })
              }
              filter={
                <FilesFilter
                  tab={tab}
                  q={q}
                  filters={filters}
                  underName={ledger.named.under}
                  onChange={(next) => void filterBy(next)}
                />
              }
              arrange={
                <FilesArrange
                  group={group}
                  sort={sort}
                  onGroup={(g) =>
                    void arrange({ group: g === 'date' ? undefined : g })
                  }
                  onSort={(s) =>
                    void arrange({ sort: s === 'newest' ? undefined : s })
                  }
                />
              }
              found={found}
              labelId={tabId}
            />
            <PageBody className="min-h-0 pt-0">
              <FilesLedger
                ledger={ledger}
                group={group}
                sort={sort}
                head={
                  <FilterChips
                    filters={filesAppliedFilters(
                      filters,
                      ledger.named,
                      (next) => void filterBy(next),
                    )}
                    onClear={() => void filterBy(NO_FILTERS)}
                  />
                }
                labelledBy={`${titleId} ${tabId}`}
                step={FILES_STEP}
                loading={loading}
                onLoadMore={() => {
                  setLoading(true)
                  void go({ n: ledger.rows.length + FILES_STEP }).finally(() =>
                    setLoading(false),
                  )
                }}
                onOpen={(id, page) => openFile(id, page)}
                empty={
                  q === '' && filtersOn(filters) === 0
                    ? 'Nothing here yet.'
                    : filtersOn(filters) > 0
                      ? 'Nothing matches that filter.'
                      : 'Nothing matches.'
                }
              />
            </PageBody>
          </>
        )}
      </FilesDrop>
    </ListPage>
  )
}

/**
 * A file that landed is a row the list reads: once the list is read again
 * its arriving row goes, whether or not the open tab, filter or search
 * shows the file.
 */
function useSettleArrivals(arrivals: ReadonlyArray<Arrival>) {
  const router = useRouter()
  const settling = useRef(new Set<string>())
  useEffect(() => {
    const landed = arrivals.filter(
      (a) => a.state.kind === 'landed' && !settling.current.has(a.key),
    )
    if (landed.length === 0) return
    for (const a of landed) settling.current.add(a.key)
    void router.invalidate().finally(() => {
      for (const a of landed) {
        dismissArrival(a.key)
        settling.current.delete(a.key)
      }
    })
  }, [arrivals, router])
}

/** How often, and how many times, the list is read again while text is read. */
const READ_POLL_MS = 2500
const READ_POLLS = 24

/**
 * Text is read on the worker, out of band: while an unfiled row is still
 * being read, read the list again so its first line and its `File under`
 * guess arrive. Bounded, so a stalled worker does not poll for ever; each
 * file that lands starts the count again.
 */
function useReadPolling(rows: ReadonlyArray<FilesLedgerRow>, landings: number) {
  const router = useRouter()
  const reading = rows.some(
    (r) => r.unfiled && r.extractionStatus === 'pending',
  )
  const [polls, setPolls] = useState(0)
  useEffect(() => setPolls(0), [landings])
  useEffect(() => {
    if (!reading || polls >= READ_POLLS) return
    const timer = setTimeout(() => {
      setPolls((n) => n + 1)
      void router.invalidate()
    }, READ_POLL_MS)
    return () => clearTimeout(timer)
  }, [reading, polls, router])
}
