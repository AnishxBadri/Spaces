import {
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { Layers } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
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
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
import { AiCell, AiCellsProvider } from '#/components/attributes/ai-cell'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { EmptyRow } from '#/components/ledger-section'
import {
  ChipLink,
  DateCell,
  IconBadge,
  RecordLinkCell,
  registryColumnMeta,
} from '#/components/table/cells'
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
import { collisionToast } from '#/lib/attributes/collision-toast'
import { objectIcon } from '#/lib/object-icons'
import { inverseColumns } from '#/components/table/inverse-columns'
import { inverseCountFilters } from '#/lib/views/inverse-fields'
import { isDerived } from '@spaces/core/attributes/relationship'
import { RECORD_PAGE_SIZE } from '#/lib/views/page-size'
import {
  countViews,
  createObjectRecord,
  getObject,
  getSession,
  listObjectRecords,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { useHotkey } from '#/lib/use-hotkey'

/**
 * The registry-generated list page for a custom object: if this
 * page can't render an object, it was never registry-generated. Name is
 * the one core-owned column; everything else is the object's attributes,
 * spaces, and when it was added.
 */
export const Route = createFileRoute('/_app/o/$objectSlug')({
  validateSearch: z.object({ view: z.string().optional() }),
  // `?view=` is the only linkable filter state, so it is the only loader dep:
  // an ad-hoc condition edit refetches through the query below instead.
  loaderDeps: ({ search }) => ({ view: search.view ?? null }),
  loader: async ({ params, deps }) => {
    const object = await getObject({ data: { slug: params.objectSlug } })
    // An archived object hides its routes; records persist.
    if (object.archived || object.isSystem) throw notFound()
    const [withInverses, viewData, session] = await Promise.all([
      // Inverse halves come too, as columns and filters.
      listRegistry({ data: { objectId: object.id, includeDerived: true } }),
      listViews({ data: { surface: 'object', objectId: object.id } }),
      getSession(),
    ])
    // The view's conditions and its sort go down with the request, so the
    // first paint is already the filtered, ordered first page — no flash of
    // the rows the view hides, and no client sort of a set it does not hold.
    const view = viewData.views.find((v) => v.id === deps.view) ?? null
    const conditions = view?.filter ?? []
    const sort = view?.sort ?? null
    // Every chip's count rides the same load, so the bar paints
    // with its numbers — the inactive views' included — beside page one.
    const [initial, counts, all] = await Promise.all([
      listObjectRecords({
        data: {
          objectId: object.id,
          conditions,
          sort,
          limit: RECORD_PAGE_SIZE,
          cursor: null,
        },
      }),
      countViews({
        data: {
          surface: 'object',
          objectId: object.id,
          viewIds: viewData.views.map((v) => v.id),
        },
      }),
      // The head's count and the All tab's: page one already is that count
      // when no view narrows it.
      view === null
        ? null
        : listObjectRecords({
            data: {
              objectId: object.id,
              conditions: [],
              sort: null,
              limit: 1,
              cursor: null,
            },
          }),
    ])
    return {
      object,
      registry: withInverses.filter((d) => !isDerived(d)),
      inverses: withInverses.filter(isDerived),
      conditions,
      sort,
      initial,
      allTotal: (all ?? initial).total,
      views: viewData.views,
      counts,
      me: session?.user ?? null,
    }
  },
  component: ObjectListPage,
})

type Row = Awaited<ReturnType<typeof listObjectRecords>>['rows'][number]
const col = createColumnHelper<Row>()

function ObjectListPage() {
  const {
    object,
    registry,
    inverses,
    conditions,
    sort: loaderSort,
    initial,
    allTotal,
    views,
    counts,
    me,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  // FROZEN: renaming resets saved column layouts with no recovery path.
  const prefs = useTablePrefs(`dealos.o-${object.slug}-table.v1`)
  const { view: activeId } = Route.useSearch()
  // "Run on this view" in an AI attribute's column header.
  const columnRun = useColumnRun({
    viewId: views.find((v) => v.id === activeId)?.id ?? null,
    registry,
  })
  const vs = useViewState({
    views,
    activeId: activeId ?? null,
    listPath: `/o/${object.slug}`,
    columnVisibility: prefs.columnVisibility,
    setColumnVisibility: prefs.setColumnVisibility,
    defaultExtra: {},
  })
  const { sorting, setSorting } = vs
  /**
   * The text box is a debounced **server** `ILIKE` on `canonical_name`: the
   * table holds one page, so a client filter would lie. It composes with the
   * view's conditions. Not ⌘K's job: that is fused search across kinds, and
   * "narrow this table" is a different question.
   */
  const [globalFilter, setGlobalFilter] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(globalFilter.trim()), 250)
    return () => clearTimeout(t)
  }, [globalFilter])

  // Normalised through one builder so the loader's key and the page's key
  // are the same string for the same sort — a jsonb column's key order is
  // not something to compare against a hand-written literal.
  const asSort = (s: { id: string; desc: boolean } | null | undefined) =>
    s ? { id: s.id, desc: s.desc } : null
  const sort = asSort(sorting[0])
  const sortKey = JSON.stringify(sort)

  /**
   * Filtering, sorting, counting and paging all happen in Postgres. The
   * loader already asked for page one of the `?view=`
   * conditions in the view's order, so the first paint — server-rendered
   * included — is that page; this query seeds itself from that answer and is
   * keyed on the conditions, the sort and the text box, so any of the three
   * changing refetches page one without a navigation. `keepPreviousData` is
   * what keeps the table showing the last answer while the next one is in
   * flight rather than blanking or falling back to an unfiltered list.
   *
   * Pages are appended, never replaced: the cursor is keyset on
   * `(sort key, id)`, so a record created between two "load more" clicks can
   * neither duplicate a row already on screen nor push one past the window.
   */
  const loaderKey = JSON.stringify({
    conditions,
    sort: asSort(loaderSort),
    q: '',
  })
  const pageOne: string | null = null
  const records = useInfiniteQuery({
    queryKey: ['object-records', object.id, vs.conditionKey, sortKey, q],
    // Annotated: the inference otherwise narrows `pageParam` to the literal
    // type of `initialPageParam` and refuses the cursor a later page carries.
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listObjectRecords({
        data: {
          objectId: object.id,
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
  // Every page brings the names its own reference cells need; later pages
  // add to the map rather than replacing it.
  const refNames = useMemo(() => {
    const out: Record<string, { name: string }> = {}
    for (const p of loaded) Object.assign(out, p.refNames)
    return out
  }, [loaded])
  const total = loaded.at(-1)?.total ?? 0
  // A write has to reach both holders of the rows: the loader for the
  // registry and the views, the query for whichever condition set is on
  // screen.
  const queryClient = useQueryClient()
  const refresh = useCallback(() => {
    void router.invalidate()
    void queryClient.invalidateQueries({ queryKey: ['object-records'] })
  }, [router, queryClient])
  const importVerb = useImportVerb(object.slug)
  const editAttribute = useEditAttribute({
    registry,
    objectId: object.id,
    objectLabel: object.singular,
    objectPlural: object.plural,
    onSaved: refresh,
  })
  const selectView = (id: string | null) =>
    void navigate({
      to: '/o/$objectSlug',
      params: { objectSlug: object.slug },
      search: id === null ? {} : { view: id },
    })
  const Icon = objectIcon(object)

  async function saveCell(entityId: string, slug: string, value: unknown) {
    try {
      const result = await updateRecord({
        data: { id: entityId, patch: { [slug]: value } },
      })
      // The grid's own half of "a conflict is never silent": an inline edit
      // that lost a domain race saved fine and claimed nothing, and the
      // only other evidence is a row in the review inbox.
      const collision = collisionToast(result, object.singular)
      if (collision)
        toast(collision.title, { description: collision.description })
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      refresh()
    }
  }

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<Row, unknown>> = [
      col.accessor('name', {
        id: 'name',
        header: object.singular,
        size: 220,
        enableHiding: false,
        cell: (info) => (
          <RecordLinkCell
            to="/o/$objectSlug/$recordId"
            params={{ objectSlug: object.slug, recordId: info.row.original.id }}
            name={String(info.getValue())}
            badge={<IconBadge icon={Icon} />}
          />
        ),
      }),
      ...registry.map((def) =>
        col.accessor((r): unknown => r.values[def.slug] ?? null, {
          id: `attr:${def.slug}`,
          header: def.name,
          size: def.type === 'text' ? 200 : 140,
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
      col.accessor((r) => r.spaces.map((s) => s.name).join(', '), {
        id: 'spaces',
        header: 'Spaces',
        size: 180,
        // The sort is a SQL order by over `entity`, and spaces are a join;
        // offering the menu would promise an order nobody can serve.
        enableSorting: false,
        cell: (info) => (
          <span className="flex flex-wrap items-center gap-1 px-1">
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
  }, [registry, inverses, object.slug, refNames])

  // The view bar filters on the inverses and their counts too.
  const filterRegistry = useMemo(
    () => [...registry, ...inverses, ...inverseCountFilters(inverses)],
    [registry, inverses],
  )

  /**
   * No `getSortedRowModel` and no `getFilteredRowModel` here, deliberately:
   * both would reorder and narrow the fifty rows that happen to be
   * loaded and call that the answer. `manualSorting`/`manualFiltering` say
   * so out loud — `sorting` is still the table's state, so the header menu
   * and the `aria-sort` on each `th` keep working, but toggling it changes
   * the query key and Postgres returns page one in the new order.
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

  // First run: the list holds nothing at all, so there is nothing to view,
  // filter or sort — one row that creates, and the head's `···`.
  const firstRun = allTotal === 0 && rows.length === 0
  const filtered = vs.conditions.length > 0 || q !== ''
  const notice = records.isError ? (
    <ListErrorRow
      plural={object.plural}
      onRetry={() => void records.refetch()}
    />
  ) : records.data === undefined ? (
    <ListLoadingRow plural={object.plural} />
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
  // Import… is this head's only rare verb, so the `···` is that verb as
  // the outline secondary, left of the primary.
  const listMenu = <ListMenu label={object.plural} verbs={[importVerb]} />

  return (
    <div className="flex flex-col">
      <PageHeader
        title={object.plural}
        action={
          firstRun ? (
            listMenu
          ) : (
            <>
              {listMenu}
              <CreateRecordDialog
                object={object}
                registry={registry}
                refNames={refNames}
                hotkey="c"
              />
            </>
          )
        }
      />
      {firstRun ? (
        <div className="px-8 pt-6 pb-8">
          <CreateRecordDialog
            object={object}
            registry={registry}
            refNames={refNames}
            hotkey="c"
            trigger={<EmptyRow name={object.plural} />}
          />
        </div>
      ) : (
        <>
          <ViewBar
            objectId={object.id}
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
            plural={object.plural}
            pinned
            refNames={refNames}
            tools={
              <TableTools
                table={table}
                filter={globalFilter}
                onFilterChange={setGlobalFilter}
                filterPlaceholder={`Search ${object.plural.toLowerCase()}`}
                filterLabel={`Search ${object.plural.toLowerCase()}`}
              />
            }
          />
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
                label={object.plural}
                stickyColumnId="name"
                notice={notice}
                pinUnder={viewBarPin(vs.conditions)}
                page={{
                  total,
                  hasMore: records.hasNextPage,
                  loading: records.isFetchingNextPage,
                  step: RECORD_PAGE_SIZE,
                  onLoadMore: () => void records.fetchNextPage(),
                }}
                addColumn={
                  <AttributeDialog
                    mode="create"
                    objectId={object.id}
                    objectLabel={object.singular}
                    objectPlural={object.plural}
                    onSaved={refresh}
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
    </div>
  )
}

/** Name first (core-owned, required at birth), then the registry's fields. */
function CreateRecordDialog({
  object,
  registry,
  refNames,
  hotkey,
  trigger,
}: {
  object: { id: string; singular: string; plural: string }
  registry: Array<RegistryEntry>
  refNames: Record<string, { name: string }>
  /** Bare key that opens it from the page — in the trigger's tooltip. */
  hotkey?: string
  /** The control that opens it; the head's New button by default. */
  trigger?: ReactNode
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!name.trim())
      return setError(`Name the ${object.singular.toLowerCase()}.`)
    setPending(true)
    try {
      const result = await createObjectRecord({
        data: {
          objectId: object.id,
          name: name.trim(),
          values: Object.fromEntries(
            Object.entries(values).filter(
              ([, v]) => v !== null && v !== undefined,
            ),
          ),
        },
      })
      setOpen(false)
      setName('')
      setValues({})
      // A record born onto a domain another record already claims is the
      // same collision an edit makes; the birth toast gives way to the one
      // that says something.
      const collision = collisionToast(result, object.singular)
      if (collision)
        toast(collision.title, { description: collision.description })
      else toast(`${name.trim()} added`)
      void router.invalidate()
      // The rows come from a keyed query, not from the loader alone.
      void queryClient.invalidateQueries({ queryKey: ['object-records'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button shortcut={hotkey?.toUpperCase()}>
            New {object.singular.toLowerCase()}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        size="m"
        className="max-h-[85vh] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New {object.singular.toLowerCase()}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
        >
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="record-name">Name</Label>
            <Input
              id="record-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {registry.map((def) => (
            <div
              key={def.slug}
              className={cn('space-y-1.5', fieldSpanClass(def))}
            >
              <Label>{def.name}</Label>
              <ValueEditor
                def={def}
                value={values[def.slug] ?? null}
                variant="field"
                refNames={refNames}
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
              {pending ? 'Adding…' : `Create ${object.singular.toLowerCase()}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
