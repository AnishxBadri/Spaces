import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { Plus, Users } from 'lucide-react'
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
import { cn } from '#/lib/utils'
import { useHotkey } from '#/lib/use-hotkey'
import { jsonRecord } from '@spaces/core/json'
import { RECORD_PAGE_SIZE } from '#/lib/views/page-size'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
import { AiCell, AiCellsProvider } from '#/components/attributes/ai-cell'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { EmptyState } from '#/components/empty-state'
import { RecordMark } from '#/components/record/record-parts'
import { TemplatePicker } from '#/components/templates'
import {
  attributeColumnMeta,
  DateCell,
  InitialBadge,
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
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select } from '#/components/ui/select'
import {
  createPerson,
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
  const loaded = useMemo(() => pages ?? [initial], [pages, initial])
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
  // Enrich… from the selection bar or the head's ···, behind an estimate.
  const enrich = useListEnrich({
    kind: 'person',
    label: 'People',
    rows,
    view: { conditions: vs.conditions, q },
    refresh,
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
          meta: attributeColumnMeta(def.type),
          cell: (info) => (
            <AiCell def={def} entityId={info.row.original.id}>
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

  return (
    <div className="flex flex-col">
      <PageHeader
        title="People"
        action={
          <>
            <ImportAction objectSlug="people" />
            <CreatePersonDialog
              companies={companies}
              registry={registry}
              hotkey="c"
            />
            {enrich.menu}
          </>
        }
      />
      {rows.length === 0 && vs.conditions.length === 0 && q === '' ? (
        <div className="px-8 pb-8">
          <EmptyState
            icon={Users}
            title="No people yet"
            body="Add someone by name and email. Email is identity — the same person arriving from two directions becomes one record."
            action={
              <CreatePersonDialog companies={companies} registry={registry} />
            }
            hint="Gmail and calendar sync will create these automatically later — through the same dedupe gate."
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
                  filterPlaceholder="Filter by name or email…"
                  filterLabel="Filter people"
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
                label="People"
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
                    objectKind="person"
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

function CreatePersonDialog({
  companies,
  registry,
  hotkey,
}: {
  companies: Array<{ id: string; name: string }>
  registry: Array<RegistryEntry>
  /** Bare key that opens it from the page — printed in the trigger. */
  hotkey?: string
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  // Submitted through `FormData`: the picker mirrors its value into a
  // hidden `company` input.
  const [company, setCompany] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const name = String(form.get('name')).trim()
    const email = String(form.get('email')).trim()
    const companyId = String(form.get('company') || '')
    if (!name) {
      setError('Name the person.')
      return
    }
    setPending(true)
    try {
      // Initial values ride the create call: the server writes them before
      // defaults fill the blanks, so a value typed here always wins.
      const result = await createPerson({
        data: {
          name,
          ...(email ? { email } : {}),
          ...(companyId ? { companyId } : {}),
          values: Object.fromEntries(
            Object.entries(values).filter(
              ([, v]) => v !== null && v !== undefined,
            ),
          ),
        },
      })
      setOpen(false)
      setValues({})
      setCompany('')
      if (result.action === 'attached') {
        toast(`Matched existing person — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      } else {
        toast(`${result.name} added`)
      }
      void router.invalidate()
      // The rows come from a keyed query, not from the loader alone.
      void queryClient.invalidateQueries({ queryKey: ['people-records'] })
    } catch {
      setError('Could not add the person.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" shortcut={hotkey?.toUpperCase()}>
          <Plus className="size-4" strokeWidth={2} />
          New person
        </Button>
      </DialogTrigger>
      <DialogContent
        size="m"
        className="max-h-[85vh] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
        </DialogHeader>
        {/* Pre-fills the fields below, visibly and editably — never writes. */}
        <div className="flex justify-end">
          <TemplatePicker
            kind="record"
            objectKind="person"
            context="person"
            onPick={(t) => {
              const tv = jsonRecord(jsonRecord(t.body).values)
              setValues((s) => ({ ...tv, ...s }))
            }}
          />
        </div>
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="person-name">Name</Label>
            <Input
              id="person-name"
              name="name"
              required
              autoFocus
              placeholder="Awais Ahmed"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="person-email">Email</Label>
            <Input
              id="person-email"
              name="email"
              type="email"
              placeholder="awais@pixxel.space"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="person-company">Company</Label>
            <Select
              id="person-company"
              name="company"
              value={company}
              onChange={setCompany}
              items={[
                { value: '', label: 'None' },
                ...companies.map((c) => ({ value: c.id, label: c.name })),
              ]}
              width="content"
              placeholder="None"
              searchPlaceholder="Search companies…"
              emptyLabel="No company matches."
              className="bg-transparent text-body"
            />
          </div>

          {/* Companies has its picker above and Email its field, the key the
              create matches on; `createPerson` writes both. */}
          {registry
            .filter(
              (def) =>
                def.slug !== 'companies' &&
                def.options?.identityKey === undefined,
            )
            .map((def) => (
              <div
                key={def.slug}
                className={cn('space-y-1.5', fieldSpanClass(def))}
              >
                <Label>{def.name}</Label>
                <ValueEditor
                  def={def}
                  value={values[def.slug] ?? null}
                  variant="field"
                  onSave={(v) => setValues((s) => ({ ...s, [def.slug]: v }))}
                />
              </div>
            ))}

          {error ? (
            <p role="alert" className="text-ui text-destructive sm:col-span-2">
              {error}
            </p>
          ) : null}

          <DialogFooter className="sm:col-span-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding\u2026' : 'Create person'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
