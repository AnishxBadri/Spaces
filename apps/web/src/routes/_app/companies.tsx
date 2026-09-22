import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { Building2, Copy, Globe, Layers, Plus } from 'lucide-react'
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
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { EmptyState } from '#/components/empty-state'
import { DitherMark } from '#/components/record/record-parts'
import { TemplatePicker } from '#/components/templates'
import {
  ChipLink,
  DateCell,
  MetaCell,
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
import { cn } from '#/lib/utils'
import { jsonRecord } from '#/lib/json'
import { RECORD_PAGE_SIZE } from '#/lib/views/page-size'
import {
  countOpenInbox,
  createCompany,
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
    const [registry, dupes, viewData, session] = await Promise.all([
      listRegistry({ data: { kind: 'company' } }),
      countOpenInbox(),
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
    const initial = await listCompaniesTable({
      data: { conditions, sort, limit: RECORD_PAGE_SIZE, cursor: null },
    })
    return {
      conditions,
      sort,
      initial,
      registry,
      // The banner speaks for one lane of the queue, not the whole of it.
      openDuplicates: dupes.byKind.duplicate_candidate,
      views: viewData.views,
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
    registry,
    openDuplicates,
    views,
    objectId,
    me,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const prefs = useTablePrefs(PREFS_KEY)
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
  const selectView = (id: string | null) =>
    void navigate({
      to: '/companies',
      search: id === null ? {} : { view: id },
    })

  async function saveCell(entityId: string, slug: string, value: unknown) {
    try {
      await updateRecord({ data: { id: entityId, patch: { [slug]: value } } })
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      refresh() // revert the editor to server truth
    }
  }

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
            badge={<DitherMark size={18} />}
          />
        ),
      }),
      col.accessor((r) => r.domains.join(', '), {
        id: 'domains',
        header: 'Domains',
        size: 170,
        // The sort is a SQL order by over `entity` now, and domains, spaces
        // and last-touched are all joins; offering the menu would promise an
        // order nobody can serve (the same call `/o/$objectSlug` made).
        enableSorting: false,
        cell: (info) =>
          info.row.original.domains.length > 0 ? (
            <MetaCell icon={Globe}>
              {info.row.original.domains.join(', ')}
            </MetaCell>
          ) : null,
      }),
      ...registry.map((def) =>
        col.accessor((r): unknown => r.values[def.slug] ?? null, {
          id: `attr:${def.slug}`,
          header: def.name,
          size: def.type === 'text' ? 200 : 140,
          cell: (info) => (
            <ValueEditor
              def={def}
              value={info.getValue()}
              variant="cell"
              onSave={(v) => saveCell(info.row.original.id, def.slug, v)}
            />
          ),
        }),
      ),
      col.accessor((r) => r.spaces.map((s) => s.name).join(', '), {
        id: 'spaces',
        header: 'Spaces',
        size: 180,
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
      col.accessor((r) => r.lastTouched ?? '', {
        id: 'lastTouched',
        header: 'Last touched',
        size: 120,
        enableSorting: false,
        cell: (info) => <DateCell value={info.row.original.lastTouched} />,
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
  }, [registry])

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
    <div className="flex h-full flex-col">
      <PageHeader
        title="Companies"
        description="Every company you track — deduped by domain, tagged into spaces."
        action={<CreateCompanyDialog registry={registry} />}
      />
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        {openDuplicates > 0 ? (
          <Link
            to="/inbox"
            className="focus-ring mt-4 flex items-center gap-2 rounded-md border border-rule bg-bone px-3 py-2 text-ui transition-colors duration-150 ease-out-quart hover:bg-bone"
          >
            <Copy className="size-3.5 text-graphite" strokeWidth={1.75} />
            <span className="tabular font-medium">{openDuplicates}</span>
            possible duplicate{openDuplicates === 1 ? '' : 's'} to review
            <span className="ml-auto text-graphite">Review →</span>
          </Link>
        ) : null}

        {rows.length === 0 && vs.conditions.length === 0 && q === '' ? (
          <EmptyState
            icon={Building2}
            title="No companies yet"
            body="Add one by name or domain. The domain is identity — the same company arriving twice becomes one record, not two."
            action={<CreateCompanyDialog registry={registry} />}
          />
        ) : (
          <>
            <TableToolbar
              table={table}
              filter={globalFilter}
              onFilterChange={setGlobalFilter}
              filterPlaceholder="Filter by name or domain…"
              filterLabel="Filter companies"
              noun={{ one: 'company', many: 'companies' }}
              total={total}
              shown={rows.length}
            >
              <ViewBar
                objectId={objectId}
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
            <RecordTable
              table={table}
              label="Companies"
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
          </>
        )}
      </div>
    </div>
  )
}

function CreateCompanyDialog({ registry }: { registry: Array<RegistryEntry> }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!name.trim() && !domain.trim()) {
      setError('Give a name or a domain — either identifies the company.')
      return
    }
    setPending(true)
    try {
      // Initial values ride the create call: the server writes them before
      // defaults fill the blanks, so a value typed here always wins.
      const result = await createCompany({
        data: {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(domain.trim() ? { domain: domain.trim() } : {}),
          values: Object.fromEntries(
            Object.entries(values).filter(
              ([, v]) => v !== null && v !== undefined,
            ),
          ),
        },
      })
      setOpen(false)
      setName('')
      setDomain('')
      setValues({})
      if (result.action === 'attached') {
        toast(`Matched existing company — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      } else {
        toast(`${result.name} added`)
      }
      void router.invalidate()
      // The rows come from a keyed query now, not from the loader alone —
      // and the dedupe banner's count comes from the loader, so both.
      void queryClient.invalidateQueries({ queryKey: ['company-records'] })
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not add the company.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          New company
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>
            Domain is the strongest identity — add it when you know it.
          </DialogDescription>
        </DialogHeader>
        {/* Pre-fills the fields below, visibly and editably — never writes. */}
        <div className="flex justify-end">
          <TemplatePicker
            kind="record"
            objectKind="company"
            context="company"
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
            <Label htmlFor="company-name">Name</Label>
            <Input
              id="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="Orbital Composites"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-domain">Domain</Label>
            <Input
              id="company-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="orbitalcomposites.com"
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
              {pending ? 'Adding…' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
