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
import { Layers, Plus } from 'lucide-react'
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
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
import { AiCell, AiCellsProvider } from '#/components/attributes/ai-cell'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { EmptyState } from '#/components/empty-state'
import {
  ChipLink,
  DateCell,
  IconBadge,
  RecordLinkCell,
} from '#/components/table/cells'
import {
  AddColumnButton,
  RecordTable,
  TableToolbar,
} from '#/components/table/record-table'
import { PageHeader } from '#/components/page-header'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { objectIcon } from '#/lib/object-icons'
import { RECORD_PAGE_SIZE } from '#/lib/views/page-size'
import {
  createObjectRecord,
  getObject,
  getSession,
  listObjectRecords,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The registry-generated list page for a custom object (spec §9): if this
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
    // An archived object hides its routes (§9 lifecycle); records persist.
    if (object.archived || object.isSystem) throw notFound()
    const [registry, viewData, session] = await Promise.all([
      listRegistry({ data: { objectId: object.id } }),
      listViews({ data: { surface: 'object', objectId: object.id } }),
      getSession(),
    ])
    // The view's conditions and its sort go down with the request (SPA-40,
    // SPA-64), so the first paint is already the filtered, ordered first
    // page — no flash of the rows the view hides, and no client sort of a
    // set the client does not hold.
    const view = viewData.views.find((v) => v.id === deps.view) ?? null
    const conditions = view?.filter ?? []
    const sort = view?.sort ?? null
    const initial = await listObjectRecords({
      data: {
        objectId: object.id,
        conditions,
        sort,
        limit: RECORD_PAGE_SIZE,
        cursor: null,
      },
    })
    return {
      object,
      registry,
      conditions,
      sort,
      initial,
      views: viewData.views,
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
    conditions,
    sort: loaderSort,
    initial,
    views,
    me,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  // FROZEN: renaming resets saved column layouts with no recovery path.
  const prefs = useTablePrefs(`dealos.o-${object.slug}-table.v1`)
  const { view: activeId } = Route.useSearch()
  const vs = useViewState({
    views,
    activeId: activeId ?? null,
    columnVisibility: prefs.columnVisibility,
    setColumnVisibility: prefs.setColumnVisibility,
    defaultExtra: {},
  })
  const { sorting, setSorting } = vs
  /**
   * The text box is a **server** `ILIKE` on `canonical_name` now, debounced
   * (SPA-64). It used to be a client `globalFilter` over every loaded row,
   * which stopped being able to tell the truth the moment the table stopped
   * loading every row. The alternative was to delete it and let ⌘K take the
   * job — rejected: ⌘K is fused search across kinds, one hit at a time, and
   * "narrow this table" is a different question. It keeps the grid, the
   * columns and the sort, and it composes with the view's conditions. The
   * fused CTE in `lib/server/search.ts` is untouched.
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
   * Filtering, sorting, counting and paging all happen in Postgres (SPA-40,
   * SPA-64). The loader already asked for page one of the `?view=`
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
  const loaded = useMemo(() => pages ?? [initial], [pages, initial])
  const rows = useMemo(() => loaded.flatMap((p) => p.rows), [loaded])
  // Every page brings the names its own reference cells need; later pages
  // add to the map rather than replacing it.
  const refNames = useMemo(() => {
    const out: Record<string, { name: string }> = {}
    for (const p of loaded) Object.assign(out, p.refNames)
    return out
  }, [loaded])
  const total = loaded.at(-1)?.total ?? 0
  // The loader is no longer the only thing holding the rows, so a write has
  // to reach both: the loader for the registry and the views, the query for
  // whichever condition set is on screen.
  const queryClient = useQueryClient()
  const refresh = useCallback(() => {
    void router.invalidate()
    void queryClient.invalidateQueries({ queryKey: ['object-records'] })
  }, [router, queryClient])
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
      col.accessor((r) => r.spaces.map((s) => s.name).join(', '), {
        id: 'spaces',
        header: 'Spaces',
        size: 180,
        // The sort is a SQL order by over `entity` now, and spaces are a
        // join; offering the menu would promise an order nobody can serve.
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
        cell: (info) => <DateCell value={info.getValue()} />,
      }),
    ]
    return defs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, object.slug, refNames])

  /**
   * No `getSortedRowModel` and no `getFilteredRowModel` here, deliberately
   * (SPA-64): both would reorder and narrow the fifty rows that happen to be
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

  const createDialog = (
    <CreateRecordDialog
      object={object}
      registry={registry}
      refNames={refNames}
    />
  )
  const noun = {
    one: object.singular.toLowerCase(),
    many: object.plural.toLowerCase(),
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={object.plural}
        description={`Every ${noun.one} you keep — your own object, your own attributes.`}
        action={createDialog}
      />
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        {rows.length === 0 && vs.conditions.length === 0 && q === '' ? (
          <EmptyState
            icon={Icon}
            title={`No ${noun.many} yet`}
            body={
              registry.length === 0
                ? `Give ${object.plural} some attributes first, then add the first ${noun.one}.`
                : `Add the first ${noun.one}. It gets every attribute on ${object.plural}, its own page, and a place in the research graph.`
            }
            action={createDialog}
          />
        ) : (
          <>
            <TableToolbar
              table={table}
              filter={globalFilter}
              onFilterChange={setGlobalFilter}
              filterPlaceholder={`Filter ${noun.many}…`}
              filterLabel={`Filter ${noun.many}`}
              noun={noun}
              total={total}
              shown={rows.length}
            >
              <ViewBar
                objectId={object.id}
                registry={registry}
                views={views}
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
              />
            </TableToolbar>
            <AiCellsProvider
              entityIds={table.getRowModel().rows.map((r) => r.original.id)}
              registry={registry}
            >
              <RecordTable
                table={table}
                label={object.plural}
                stickyColumnId="name"
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
                    onSaved={refresh}
                    trigger={<AddColumnButton />}
                  />
                }
              />
            </AiCellsProvider>
          </>
        )}
      </div>
    </div>
  )
}

/** Name first (core-owned, required at birth), then the registry's fields. */
function CreateRecordDialog({
  object,
  registry,
  refNames,
}: {
  object: { id: string; singular: string; plural: string }
  registry: Array<RegistryEntry>
  refNames: Record<string, { name: string }>
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
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
      // The rows come from a keyed query now, not from the loader alone.
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
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          New {object.singular.toLowerCase()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New {object.singular.toLowerCase()}</DialogTitle>
          <DialogDescription>
            The name is what mentions, search, and references show. Everything
            else can wait.
          </DialogDescription>
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
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : `Create ${object.singular.toLowerCase()}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
