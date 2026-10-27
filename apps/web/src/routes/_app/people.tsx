import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { ViewBar, viewBarPin } from '#/components/views/view-bar'
import { useViewState } from '#/components/views/use-view-state'
import { useColumnRun } from '#/components/views/column-run'
import { RECORD_PAGE_SIZE } from '#/lib/views/page-size'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { ValueEditor } from '#/components/attributes/value-editor'
import { AiCell, AiCellsProvider } from '#/components/attributes/ai-cell'
import { EmptyRow } from '#/components/ledger-section'
import { PIN_UNDER_HEAD_BAR } from '#/components/head-fold'
import { RecordMark } from '#/components/record/record-parts'
import {
  DateCell,
  InitialBadge,
  RecordLinkCell,
  registryColumnMeta,
} from '#/components/table/cells'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { identityFirst } from '#/lib/attributes/identity-first'
import {
  AddColumnButton,
  RecordTable,
  TableTools,
} from '#/components/table/record-table'
import { PageHeader } from '#/components/page-header'
import { useImportVerb } from '#/components/import/import-action'
import { ListMenu } from '#/components/table/list-menu'
import {
  ListErrorRow,
  ListLoadingRow,
  ListZeroRow,
} from '#/components/table/list-states'
import { useEditAttribute } from '#/components/table/edit-attribute'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { useListActions } from '#/components/table/list-actions'
import { statColumns } from '#/components/table/stat-columns'
import { inverseColumns } from '#/components/table/inverse-columns'
import { INTERACTION_STAT_FILTERS } from '#/lib/views/stat-fields'
import { inverseCountFilters } from '#/lib/views/inverse-fields'
import { isDerived } from '@spaces/core/attributes/relationship'
import { CreatePersonDialog } from '#/components/create-person-dialog'
import {
  countViews,
  getSession,
  listCompanies,
  listPeopleTable,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/people')({
  validateSearch: z.object({ view: z.string().optional() }),
  // `?view=` is the only linkable filter state, so it is the only loader dep:
  // an ad-hoc condition edit refetches through the query below instead.
  loaderDeps: ({ search }) => ({ view: search.view ?? null }),
  loader: async ({ deps }) => {
    const [withInverses, companies, viewData, session] = await Promise.all([
      // Inverse halves (Deals) come too, as columns and filters.
      listRegistry({ data: { kind: 'person', includeDerived: true } }),
      listCompanies(),
      listViews({ data: { surface: 'object', kind: 'person' } }),
      getSession(),
    ])
    // The view's conditions and its sort go down with the request, so the
    // first paint is already the filtered, ordered first page rather than
    // every person with most of them hidden.
    const view = viewData.views.find((v) => v.id === deps.view) ?? null
    const conditions = view?.filter ?? []
    const sort = view?.sort ?? null
    // Every chip's count rides the same load, so the bar paints
    // with its numbers — the inactive views' included — beside page one.
    const [initial, counts, all] = await Promise.all([
      listPeopleTable({
        data: { conditions, sort, limit: RECORD_PAGE_SIZE, cursor: null },
      }),
      countViews({
        data: {
          surface: 'object',
          kind: 'person',
          viewIds: viewData.views.map((v) => v.id),
        },
      }),
      // The head's count and the All tab's: page one already is that count
      // when no view narrows it.
      view === null
        ? null
        : listPeopleTable({
            data: { conditions: [], sort: null, limit: 1, cursor: null },
          }),
    ])
    return {
      conditions,
      sort,
      initial,
      allTotal: (all ?? initial).total,
      registry: withInverses.filter((d) => !isDerived(d)),
      inverses: withInverses.filter(isDerived),
      companies,
      views: viewData.views,
      counts,
      objectId: viewData.objectId,
      me: session?.user ?? null,
    }
  },
  component: PeoplePage,
})

type Row = Awaited<ReturnType<typeof listPeopleTable>>['rows'][number]

const col = createColumnHelper<Row>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'dealos.people-table.v1'

function PeoplePage() {
  const {
    conditions,
    sort: loaderSort,
    initial,
    allTotal,
    registry,
    inverses,
    companies,
    views,
    counts,
    objectId,
    me,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const prefs = useTablePrefs(PREFS_KEY)
  const { view: activeId } = Route.useSearch()
  // "Run on this view" in an AI attribute's column header.
  const columnRun = useColumnRun({
    viewId: views.find((v) => v.id === activeId)?.id ?? null,
    registry,
  })
  const vs = useViewState({
    views,
    activeId: activeId ?? null,
    listPath: '/people',
    columnVisibility: prefs.columnVisibility,
    setColumnVisibility: prefs.setColumnVisibility,
    defaultExtra: {},
  })
  const { sorting, setSorting } = vs
  /**
   * The text box is a debounced **server** `ILIKE` on the name or any
   * identity email: the table holds one page, so a client filter would lie.
   * The employer is a join, not a column, so it does not match it and the
   * placeholder does not promise it.
   */
  const [globalFilter, setGlobalFilter] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(globalFilter.trim()), 250)
    return () => clearTimeout(t)
  }, [globalFilter])

  const asSort = (s: { id: string; desc: boolean } | null | undefined) =>
    s ? { id: s.id, desc: s.desc } : null
  const sort = asSort(sorting[0])
  const sortKey = JSON.stringify(sort)

  /**
   * Filtering, sorting, counting and paging all happen in Postgres, on the
   * same contract `/o/$objectSlug` and `/companies` use. The loader asked for
   * page one of the `?view=` conditions; this query seeds itself from that
   * answer and refetches page one whenever the conditions, the sort or the
   * text box change — no navigation, and `keepPreviousData` rather than a
   * blank table while the next answer is in flight.
   */
  const loaderKey = JSON.stringify({
    conditions,
    sort: asSort(loaderSort),
    q: '',
  })
  const pageOne: string | null = null
  const records = useInfiniteQuery({
    queryKey: ['people-records', vs.conditionKey, sortKey, q],
    // Annotated: the inference otherwise narrows `pageParam` to the literal
    // type of `initialPageParam` and refuses the cursor a later page carries.
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listPeopleTable({
        data: {
          conditions: vs.conditions,
          cursor: pageParam,
          limit: RECORD_PAGE_SIZE,
          sort,
          q,
        },
      }),
    initialPageParam: pageOne,
    getNextPageParam: (last) => last.nextCursor,
    ...(JSON.stringify({ conditions: vs.conditions, sort, q }) === loaderKey
      ? { initialData: { pages: [initial], pageParams: [pageOne] } }
      : {}),
    placeholderData: keepPreviousData,
  })
  const pages = records.data?.pages
  const loaded = useMemo(() => pages ?? [], [pages])
  const rows = useMemo(() => loaded.flatMap((p) => p.rows), [loaded])
  // Names for the reference cells (Companies among them), every loaded page.
  const refNames = useMemo(() => {
    const out: Record<string, { name: string }> = {}
    for (const p of loaded) Object.assign(out, p.refNames)
    return out
  }, [loaded])
  const total = loaded.at(-1)?.total ?? 0

  // Both halves: the loader for the registry and the views, the query for
  // whichever condition set is on screen. A row edited out of the active
  // filter leaves on this refetch, and `total` comes back down with it.
  const queryClient = useQueryClient()
  const refresh = useCallback(() => {
    void router.invalidate()
    void queryClient.invalidateQueries({ queryKey: ['people-records'] })
  }, [router, queryClient])
  // The selection bar, the row `···` and Enrich… over the view.
  const actions = useListActions({
    label: 'People',
    noun: { one: 'person', many: 'people' },
    rows,
    hrefOf: (r) => `/people/${r.id}`,
    enrich: { kind: 'person', view: { conditions: vs.conditions, q } },
    refresh,
  })
  const importVerb = useImportVerb('people')
  const editAttribute = useEditAttribute({
    registry,
    objectLabel: 'person',
    objectPlural: 'People',
    fillFrom: 'person',
    onSaved: refresh,
  })
  const selectView = (id: string | null) =>
    void navigate({ to: '/people', search: id === null ? {} : { view: id } })

  async function saveCell(entityId: string, slug: string, value: unknown) {
    try {
      const result = await updateRecord({
        data: { id: entityId, patch: { [slug]: value } },
      })
      const collision = collisionToast(result, 'person')
      if (collision)
        toast(collision.title, { description: collision.description })
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      refresh()
    }
  }

  // The view bar filters on the inverses, their counts and the stat
  // columns too; a record's editors never see the last two.
  const filterRegistry = useMemo(
    () => [
      ...registry,
      ...inverses,
      ...inverseCountFilters(inverses),
      ...INTERACTION_STAT_FILTERS,
    ],
    [registry, inverses],
  )

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<Row, unknown>> = [
      col.accessor('name', {
        id: 'name',
        header: 'Person',
        size: 200,
        enableHiding: false,
        cell: (info) => (
          <RecordLinkCell
            to="/people/$personId"
            params={{ personId: info.row.original.id }}
            name={String(info.getValue())}
            badge={
              <RecordMark
                picture={info.row.original.picture}
                size={18}
                fallback={<InitialBadge name={String(info.getValue())} />}
              />
            }
          />
        ),
      }),
      // Emails are an attribute like any other, so they sort and
      // filter through the views compiler; shown first, beside the name.
      ...identityFirst(registry).map((def) =>
        col.accessor((r): unknown => r.values[def.slug] ?? null, {
          id: `attr:${def.slug}`,
          header: def.name,
          size: def.type === 'text' ? 180 : 140,
          meta: registryColumnMeta(def),
          cell: (info) => (
            <AiCell
              def={def}
              entityId={info.row.original.id}
              value={info.getValue()}
            >
              <ValueEditor
                def={def}
                value={info.getValue()}
                variant="cell"
                refNames={refNames}
                onSave={(v) => saveCell(info.row.original.id, def.slug, v)}
              />
            </AiCell>
          ),
        }),
      ),
      ...inverseColumns<Row>(inverses, { refNames, onSave: saveCell }),
      // Read-only, from the interaction stats; sorted on the server.
      ...statColumns<Row>(),
      col.accessor('createdAt', {
        id: 'createdAt',
        header: 'Added',
        size: 110,
        meta: { numeric: true },
        cell: (info) => <DateCell value={info.getValue()} />,
      }),
    ]
    return defs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, inverses, refNames])

  // No `getSortedRowModel` and no `getFilteredRowModel`: both would reorder
  // and narrow the loaded page and call that the answer. `manualSorting` /
  // `manualFiltering` say so — `sorting` stays the table's state, so the
  // header menu and `aria-sort` keep working, and toggling it re-queries.
  const table = useReactTable({
    data: rows,
    columns,
    state: {
      sorting,
      columnVisibility: prefs.columnVisibility,
      columnSizing: prefs.columnSizing,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: prefs.setColumnVisibility,
    onColumnSizingChange: prefs.setColumnSizing,
    manualSorting: true,
    manualFiltering: true,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
  })

  // First run: the list holds nothing at all, so there is nothing to view,
  // filter or sort — one row that creates, and the head's `···`.
  const firstRun = allTotal === 0 && rows.length === 0
  const filtered = vs.conditions.length > 0 || q !== ''
  const notice = records.isError ? (
    <ListErrorRow plural="People" onRetry={() => void records.refetch()} />
  ) : records.data === undefined ? (
    <ListLoadingRow plural="People" />
  ) : rows.length === 0 ? (
    <ListZeroRow
      onClear={
        filtered
          ? () => {
              vs.setConditions([])
              setGlobalFilter('')
            }
          : undefined
      }
    />
  ) : undefined
  const listMenu = (
    <ListMenu
      label="People"
      verbs={[importVerb, ...(actions.enrichVerb ? [actions.enrichVerb] : [])]}
    />
  )

  return (
    <div className="flex flex-col">
      <PageHeader
        title="People"
        action={
          firstRun ? (
            listMenu
          ) : (
            <>
              <CreatePersonDialog
                companies={companies}
                registry={registry}
                hotkey="c"
              />
              {listMenu}
            </>
          )
        }
      />
      {firstRun ? (
        <div className="px-8 pt-6 pb-8">
          <CreatePersonDialog
            companies={companies}
            registry={registry}
            hotkey="c"
            trigger={<EmptyRow name="People" />}
          />
        </div>
      ) : (
        <>
          {actions.selectionBar ? (
            <div className={PIN_UNDER_HEAD_BAR}>{actions.selectionBar}</div>
          ) : (
            <ViewBar
              objectId={objectId}
              registry={filterRegistry}
              views={views}
              counts={counts}
              total={allTotal}
              activeId={activeId ?? null}
              snapshot={vs.snapshot}
              onApply={(v) => {
                vs.apply(v)
                selectView(v?.id ?? null)
              }}
              selectView={selectView}
              onFilterChange={vs.setConditions}
              onSaved={() => void router.invalidate()}
              canEdit={(v) => v.createdBy === me?.id || me?.role === 'admin'}
              plural="People"
              pinned
              refNames={refNames}
              tools={
                <TableTools
                  table={table}
                  filter={globalFilter}
                  onFilterChange={setGlobalFilter}
                  filterPlaceholder="Search people"
                  filterLabel="Search people"
                />
              }
            />
          )}
          <div className="px-8 pb-8">
            <AiCellsProvider
              table
              entityIds={table.getRowModel().rows.map((r) => r.original.id)}
              registry={registry}
            >
              <RecordTable
                columnActions={(id) => [
                  ...columnRun.columnActions(id),
                  ...editAttribute.columnActions(id),
                ]}
                table={table}
                label="People"
                select={actions.select}
                rowEnd={actions.rowMenu}
                stickyColumnId="name"
                notice={notice}
                pinUnder={
                  actions.selectionBar ? 'bar' : viewBarPin(vs.conditions)
                }
                page={{
                  total,
                  hasMore: records.hasNextPage,
                  loading: records.isFetchingNextPage,
                  step: RECORD_PAGE_SIZE,
                  onLoadMore: () => void records.fetchNextPage(),
                }}
                addColumn={
                  <AttributeCreateDialog
                    objectKind="person"
                    onCreated={refresh}
                    trigger={<AddColumnButton />}
                  />
                }
              />
            </AiCellsProvider>
          </div>
          {columnRun.dialog}
          {editAttribute.dialog}
        </>
      )}
      {actions.dialogs}
    </div>
  )
}
