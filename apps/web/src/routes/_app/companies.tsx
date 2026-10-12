import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { Building2, Layers } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { ViewBar } from '#/components/views/view-bar'
import { useViewState } from '#/components/views/use-view-state'
import { useColumnRun } from '#/components/views/column-run'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { ValueEditor } from '#/components/attributes/value-editor'
import { AiCell, AiCellsProvider } from '#/components/attributes/ai-cell'
import { EmptyState } from '#/components/empty-state'
import { DitherMark, RecordMark } from '#/components/record/record-parts'
import { CreateCompanyDialog } from '#/components/create-company-dialog'
import {
  attributeColumnMeta,
  ChipLink,
  DateCell,
  RecordLinkCell,
} from '#/components/table/cells'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { identityFirst } from '#/lib/attributes/identity-first'
import {
  AddColumnButton,
  RecordTable,
  TableTools,
} from '#/components/table/record-table'
import { PageHeader } from '#/components/page-header'
import { ImportAction } from '#/components/import/import-action'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { useListEnrich } from '#/components/table/bulk-enrich-dialog'
import { statColumns } from '#/components/table/stat-columns'
import { inverseColumns } from '#/components/table/inverse-columns'
import { INTERACTION_STAT_FILTERS } from '#/lib/views/stat-fields'
import { inverseCountFilters } from '#/lib/views/inverse-fields'
import { isDerived } from '@spaces/core/attributes/relationship'
import type { RefNames } from '#/components/attributes/value-editor'
import { RECORD_PAGE_SIZE } from '#/lib/views/page-size'
import {
  countViews,
  getSession,
  listCompaniesTable,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/companies')({
  validateSearch: z.object({ view: z.string().optional() }),
  // `?view=` is the only linkable filter state, so it is the only loader dep:
  // an ad-hoc condition edit refetches through the query below instead.
  loaderDeps: ({ search }) => ({ view: search.view ?? null }),
  loader: async ({ deps }) => {
    const [withInverses, viewData, session] = await Promise.all([
      // Inverse halves (Team) come too: they are columns and filters, read
      // from the links the list page fills each row with. (D69)
      listRegistry({ data: { kind: 'company', includeDerived: true } }),
      listViews({ data: { surface: 'object', kind: 'company' } }),
      getSession(),
    ])
    // The view's conditions and its sort go down with the request (SPA-96,
    // on views-3's contract), so the first paint is already the filtered,
    // ordered first page — no flash of the rows the view hides, and no
    // client sort of a set the client does not hold.
    const view = viewData.views.find((v) => v.id === deps.view) ?? null
    const conditions = view?.filter ?? []
    const sort = view?.sort ?? null
    // Every chip's count rides the same load (SPA-162), so the bar paints
    // with its numbers — the inactive views' included — beside page one.
    const [initial, counts, all] = await Promise.all([
      listCompaniesTable({
        data: { conditions, sort, limit: RECORD_PAGE_SIZE, cursor: null },
      }),
      countViews({
        data: {
          surface: 'object',
          kind: 'company',
          viewIds: viewData.views.map((v) => v.id),
        },
      }),
      // The head's count and the All tab's: page one already is that count
      // when no view narrows it.
      view === null
        ? null
        : listCompaniesTable({
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
      views: viewData.views,
      counts,
      objectId: viewData.objectId,
      me: session?.user ?? null,
    }
  },
  component: CompaniesPage,
})

type Row = Awaited<ReturnType<typeof listCompaniesTable>>['rows'][number]

const col = createColumnHelper<Row>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'dealos.companies-table.v1'

function CompaniesPage() {
  const {
    conditions,
    sort: loaderSort,
    initial,
    allTotal,
    registry,
    inverses,
    views,
    counts,
    objectId,
    me,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const prefs = useTablePrefs(PREFS_KEY)
  const { view: activeId } = Route.useSearch()
  // SPA-122: "Run on this view" in an AI attribute's column header.
  const columnRun = useColumnRun({
    viewId: views.find((v) => v.id === activeId)?.id ?? null,
    registry,
  })
  const vs = useViewState({
    views,
    activeId: activeId ?? null,
    listPath: '/companies',
    columnVisibility: prefs.columnVisibility,
    setColumnVisibility: prefs.setColumnVisibility,
    defaultExtra: {},
  })
  const { sorting, setSorting } = vs
  /**
   * The text box is a **server** narrowing now (SPA-96): `ILIKE` on the name
   * or on any identity domain, debounced. It used to be a client
   * `globalFilter` over every loaded row, which stopped being able to tell
   * the truth the moment the table stopped loading every row. Spaces dropped
   * out of what it matches — they are a join, not a column — so the
   * placeholder no longer promises them.
   */
  const [globalFilter, setGlobalFilter] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(globalFilter.trim()), 250)
    return () => clearTimeout(t)
  }, [globalFilter])

  // Normalised through one builder so the loader's key and the page's key
  // are the same string for the same sort.
  const asSort = (s: { id: string; desc: boolean } | null | undefined) =>
    s ? { id: s.id, desc: s.desc } : null
  const sort = asSort(sorting[0])
  const sortKey = JSON.stringify(sort)

  /**
   * Filtering, sorting, counting and paging all happen in Postgres. The
   * loader already asked for page one of the `?view=` conditions in the
   * view's order, so the first paint — server-rendered included — is that
   * page; this query seeds itself from that answer and is keyed on the
   * conditions, the sort and the text box, so any of the three changing
   * refetches page one without a navigation. `keepPreviousData` keeps the
   * table showing the last answer while the next is in flight.
   */
  const loaderKey = JSON.stringify({
    conditions,
    sort: asSort(loaderSort),
    q: '',
  })
  const pageOne: string | null = null
  const records = useInfiniteQuery({
    queryKey: ['company-records', vs.conditionKey, sortKey, q],
    // Annotated: the inference otherwise narrows `pageParam` to the literal
    // type of `initialPageParam` and refuses the cursor a later page carries.
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listCompaniesTable({
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
  const loaded = useMemo(() => pages ?? [initial], [pages, initial])
  const rows = useMemo(() => loaded.flatMap((p) => p.rows), [loaded])
  const total = loaded.at(-1)?.total ?? 0
  const refNames = useMemo(() => {
    const out: RefNames = {}
    for (const p of loaded) Object.assign(out, p.refNames)
    return out
  }, [loaded])

  /**
   * The loader is no longer the only thing holding the rows, so a write has
   * to reach both: the loader for the registry, the duplicate count and the
   * views, the query for whichever condition set is on screen. Invalidating
   * the prefix refetches every loaded page of the active key — which is how
   * a row edited out of the active filter leaves, and how `total` follows it
   * down rather than disagreeing with the grid.
   */
  const queryClient = useQueryClient()
  const refresh = useCallback(() => {
    void router.invalidate()
    void queryClient.invalidateQueries({ queryKey: ['company-records'] })
  }, [router, queryClient])
  // Enrich… from the selection bar or the head's ···, behind an estimate. (D76)
  const enrich = useListEnrich({
    kind: 'company',
    label: 'Companies',
    rows,
    view: { conditions: vs.conditions, q },
    refresh,
  })
  const selectView = (id: string | null) =>
    void navigate({
      to: '/companies',
      search: id === null ? {} : { view: id },
    })

  async function saveCell(entityId: string, slug: string, value: unknown) {
    try {
      const result = await updateRecord({
        data: { id: entityId, patch: { [slug]: value } },
      })
      const collision = collisionToast(result, 'company')
      if (collision)
        toast(collision.title, { description: collision.description })
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      refresh() // revert the editor to server truth
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
        header: 'Company',
        size: 220,
        enableHiding: false,
        cell: (info) => (
          <RecordLinkCell
            to="/companies/$companyId"
            params={{ companyId: info.row.original.id }}
            name={String(info.getValue())}
            badge={
              <RecordMark
                picture={info.row.original.picture}
                size={18}
                fallback={<DitherMark size={18} />}
              />
            }
          />
        ),
      }),
      // Domains are an attribute like any other (D75), so they sort and
      // filter through the views compiler; shown first, beside the name.
      ...identityFirst(registry).map((def) =>
        col.accessor((r): unknown => r.values[def.slug] ?? null, {
          id: `attr:${def.slug}`,
          header: def.name,
          size: def.type === 'text' ? 200 : 140,
          meta: attributeColumnMeta(def.type),
          cell: (info) => (
            <AiCell def={def} entityId={info.row.original.id}>
              <ValueEditor
                def={def}
                value={info.getValue()}
                variant="cell"
                onSave={(v) => saveCell(info.row.original.id, def.slug, v)}
              />
            </AiCell>
          ),
        }),
      ),
      ...inverseColumns<Row>(inverses, { refNames, onSave: saveCell }),
      col.accessor((r) => r.spaces.map((s) => s.name).join(', '), {
        id: 'spaces',
        header: 'Spaces',
        size: 180,
        enableSorting: false,
        cell: (info) => (
          <span className="flex items-center gap-1 overflow-hidden px-1">
            {info.row.original.spaces.map((s) => (
              <ChipLink
                key={s.id}
                to="/spaces/$spaceId"
                params={{ spaceId: s.id }}
                icon={Layers}
                label={s.name}
              />
            ))}
          </span>
        ),
      }),
      // Read-only, from the interaction stats; sorted on the server. (D67)
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

  /**
   * No `getSortedRowModel` and no `getFilteredRowModel`, deliberately: both
   * would reorder and narrow the fifty rows that happen to be loaded and
   * call that the answer. `manualSorting`/`manualFiltering` say so out loud —
   * `sorting` is still the table's state, so the header menu and the
   * `aria-sort` on each `th` keep working, but toggling it changes the query
   * key and Postgres returns page one in the new order.
   */
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

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Companies"
        count={allTotal}
        action={
          <>
            <ImportAction objectSlug="companies" />
            <CreateCompanyDialog registry={registry} hotkey="c" />
            {enrich.menu}
          </>
        }
      />
      {rows.length === 0 && vs.conditions.length === 0 && q === '' ? (
        <div className="px-8 pb-8">
          <EmptyState
            icon={Building2}
            title="No companies yet"
            body="Add one by name or domain. The domain is identity — the same company arriving twice becomes one record, not two."
            action={<CreateCompanyDialog registry={registry} />}
          />
        </div>
      ) : (
        <>
          {enrich.selectionBar ?? (
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
              tools={
                <TableTools
                  table={table}
                  filter={globalFilter}
                  onFilterChange={setGlobalFilter}
                  filterPlaceholder="Filter by name or domain…"
                  filterLabel="Filter companies"
                />
              }
            />
          )}
          <div className="px-8 pb-8">
            <AiCellsProvider
              entityIds={table.getRowModel().rows.map((r) => r.original.id)}
              registry={registry}
            >
              <RecordTable
                columnActions={columnRun.columnActions}
                table={table}
                label="Companies"
                select={enrich.select}
                stickyColumnId="name"
                page={{
                  total,
                  hasMore: records.hasNextPage,
                  loading: records.isFetchingNextPage,
                  step: RECORD_PAGE_SIZE,
                  onLoadMore: () => void records.fetchNextPage(),
                }}
                addColumn={
                  <AttributeCreateDialog
                    objectKind="company"
                    onCreated={refresh}
                    trigger={<AddColumnButton />}
                  />
                }
              />
            </AiCellsProvider>
          </div>
          {columnRun.dialog}
        </>
      )}
      {enrich.dialog}
    </div>
  )
}
