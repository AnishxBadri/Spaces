import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { Building2, Copy, Globe, Layers, Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { ViewBar } from '#/components/views/view-bar'
import { useViewState } from '#/components/views/use-view-state'
import { matchesConditions } from '#/lib/views/filter'
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
import {
  countOpenDuplicates,
  createCompany,
  getSession,
  listCompaniesTable,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/companies')({
  validateSearch: z.object({ view: z.string().optional() }),
  loader: async () => {
    const [rows, registry, dupes, viewData, session] = await Promise.all([
      listCompaniesTable(),
      listRegistry({ data: { kind: 'company' } }),
      countOpenDuplicates(),
      listViews({ data: { kind: 'company' } }),
      getSession(),
    ])
    return {
      rows,
      registry,
      openDuplicates: dupes.open,
      views: viewData.views,
      objectId: viewData.objectId,
      me: session?.user ?? null,
    }
  },
  component: CompaniesPage,
})

type Row = Awaited<ReturnType<typeof listCompaniesTable>>[number]

const col = createColumnHelper<Row>()
const PREFS_KEY = 'dealos.companies-table.v1'

function CompaniesPage() {
  const { rows, registry, openDuplicates, views, objectId, me } =
    Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [globalFilter, setGlobalFilter] = useState('')
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
  const typeOf = useCallback(
    (slug: string) => registry.find((d) => d.slug === slug)?.type,
    [registry],
  )
  const visibleRows = useMemo(
    () =>
      rows.filter((r) => matchesConditions(r.values, vs.conditions, typeOf)),
    [rows, vs.conditions, typeOf],
  )
  const selectView = (id: string | null) =>
    void navigate({ to: '/companies', search: { view: id ?? undefined } })

  async function saveCell(entityId: string, slug: string, value: unknown) {
    try {
      await updateRecord({ data: { id: entityId, patch: { [slug]: value } } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      void router.invalidate() // revert the editor to server truth
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
        cell: (info) =>
          info.row.original.domains.length > 0 ? (
            <MetaCell icon={Globe}>
              {info.row.original.domains.join(', ')}
            </MetaCell>
          ) : null,
      }),
      ...registry.map(
        (def) =>
          col.accessor((r) => r.values[def.slug] ?? null, {
            id: `attr:${def.slug}`,
            header: def.name,
            size: def.type === 'text' ? 200 : 140,
            sortUndefined: 'last',
            cell: (info) => (
              <ValueEditor
                def={def as RegistryEntry}
                value={info.getValue()}
                variant="cell"
                onSave={(v) => saveCell(info.row.original.id, def.slug, v)}
              />
            ),
          }) as ColumnDef<Row, unknown>,
      ),
      col.accessor((r) => r.spaces.map((s) => s.name).join(', '), {
        id: 'spaces',
        header: 'Spaces',
        size: 180,
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
        sortUndefined: 'last',
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

  const table = useReactTable({
    data: visibleRows,
    columns,
    state: {
      sorting,
      columnVisibility: prefs.columnVisibility,
      columnSizing: prefs.columnSizing,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: prefs.setColumnVisibility,
    onColumnSizingChange: prefs.setColumnSizing,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _colId, filter) => {
      const q = String(filter).toLowerCase()
      return (
        row.original.name.toLowerCase().includes(q) ||
        row.original.domains.some((d) => d.includes(q)) ||
        row.original.spaces.some((s) => s.name.toLowerCase().includes(q))
      )
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange',
  })

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Companies"
        description="Every company you track — deduped by domain, tagged into spaces."
        action={
          <CreateCompanyDialog registry={registry as Array<RegistryEntry>} />
        }
      />
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        {openDuplicates > 0 ? (
          <Link
            to="/dedupe"
            className="focus-ring mt-4 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-ui transition-colors duration-150 ease-out-quart hover:bg-accent"
          >
            <Copy
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.75}
            />
            <span className="tabular font-medium">{openDuplicates}</span>
            possible duplicate{openDuplicates === 1 ? '' : 's'} to review
            <span className="ml-auto text-muted-foreground">Review →</span>
          </Link>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No companies yet"
            body="Add one by name or domain. The domain is identity — the same company arriving twice becomes one record, not two."
            action={
              <CreateCompanyDialog
                registry={registry as Array<RegistryEntry>}
              />
            }
          />
        ) : (
          <>
            <TableToolbar
              table={table}
              filter={globalFilter}
              onFilterChange={setGlobalFilter}
              filterPlaceholder="Filter by name, domain, space…"
              filterLabel="Filter companies"
              noun={{ one: 'company', many: 'companies' }}
              total={rows.length}
              shown={table.getRowModel().rows.length}
            >
              <ViewBar
                objectId={objectId}
                registry={registry as Array<RegistryEntry>}
                views={views}
                activeId={activeId ?? null}
                snapshot={vs.snapshot}
                onApply={(v) => {
                  vs.apply(v)
                  selectView(v?.id ?? null)
                }}
                selectView={selectView}
                onFilterChange={vs.setConditions}
                onSaved={() => router.invalidate()}
                canEdit={(v) => v.createdBy === me?.id || me?.role === 'admin'}
              />
            </TableToolbar>
            <RecordTable
              table={table}
              label="Companies"
              stickyColumnId="name"
              addColumn={
                <AttributeCreateDialog
                  objectKind="company"
                  onCreated={() => router.invalidate()}
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
          name: name.trim() || undefined,
          domain: domain.trim() || undefined,
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
              const tv = (t.body as { values?: Record<string, unknown> }).values
              if (tv) setValues((s) => ({ ...tv, ...s }))
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
