import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type {
  ColumnDef,
  ColumnSizingState,
  SortingState,
  VisibilityState,
} from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  Building2,
  Columns3,
  Copy,
  Globe,
  Layers,
  Plus,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { ValueEditor } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { EmptyState } from '#/components/empty-state'
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  countOpenDuplicates,
  createCompany,
  listCompaniesTable,
  listRegistry,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/companies')({
  loader: async () => {
    const [rows, registry, dupes] = await Promise.all([
      listCompaniesTable(),
      listRegistry({ data: { kind: 'company' } }),
      countOpenDuplicates(),
    ])
    return { rows, registry, openDuplicates: dupes.open }
  },
  component: CompaniesPage,
})

type Row = Awaited<ReturnType<typeof listCompaniesTable>>[number]

const col = createColumnHelper<Row>()
const PREFS_KEY = 'dealos.companies-table.v1'

const dateFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

function loadPrefs(): {
  columnVisibility?: VisibilityState
  columnSizing?: ColumnSizingState
} {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function CompaniesPage() {
  const { rows, registry, openDuplicates } = Route.useLoaderData()
  const router = useRouter()
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => loadPrefs().columnVisibility ?? {},
  )
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(
    () => loadPrefs().columnSizing ?? {},
  )

  useEffect(() => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ columnVisibility, columnSizing }),
    )
  }, [columnVisibility, columnSizing])

  async function saveCell(entityId: string, slug: string, value: unknown) {
    try {
      await updateRecord({ data: { id: entityId, patch: { [slug]: value } } })
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      router.invalidate() // revert the editor to server truth
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
          <Link
            to="/companies/$companyId"
            params={{ companyId: info.row.original.id }}
            className="flex h-full min-w-0 items-center gap-2 px-1 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted">
              <Building2 className="size-3 text-muted-foreground" strokeWidth={1.75} />
            </span>
            <span className="truncate">{info.getValue()}</span>
          </Link>
        ),
      }) as ColumnDef<Row, unknown>,
      col.accessor((r) => r.domains.join(', '), {
        id: 'domains',
        header: 'Domains',
        size: 170,
        cell: (info) =>
          info.row.original.domains.length > 0 ? (
            <span className="flex items-center gap-1.5 truncate px-1 text-muted-foreground">
              <Globe className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate">
                {info.row.original.domains.join(', ')}
              </span>
            </span>
          ) : null,
      }) as ColumnDef<Row, unknown>,
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
              <Link
                key={s.id}
                to="/spaces/$spaceId"
                params={{ spaceId: s.id }}
                className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <Layers className="size-2.5" strokeWidth={1.75} />
                {s.name}
              </Link>
            ))}
          </span>
        ),
      }) as ColumnDef<Row, unknown>,
      col.accessor('createdAt', {
        id: 'createdAt',
        header: 'Added',
        size: 110,
        cell: (info) => (
          <span className="tabular block px-1 text-right text-xs text-muted-foreground/80">
            {dateFmt.format(new Date(info.getValue()))}
          </span>
        ),
      }) as ColumnDef<Row, unknown>,
    ]
    return defs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry])

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnVisibility, columnSizing, globalFilter },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
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
    <div className="flex h-full flex-col px-6 py-6 md:px-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            Companies
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Every company you track — deduped by domain, tagged into spaces.
          </p>
        </div>
        <CreateCompanyDialog registry={registry as Array<RegistryEntry>} />
      </header>

      {openDuplicates > 0 ? (
        <Link
          to="/dedupe"
          className="mt-4 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Copy className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
          <span className="tabular font-medium">{openDuplicates}</span>
          possible duplicate{openDuplicates === 1 ? '' : 's'} to review
          <span className="ml-auto text-xs text-muted-foreground">Review →</span>
        </Link>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No companies yet"
          body="Add one by name or domain. The domain is identity — the same company arriving twice becomes one record, not two."
          action={<CreateCompanyDialog registry={registry as Array<RegistryEntry>} />}
        />
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Filter by name, domain, space…"
              aria-label="Filter companies"
              className="h-8 max-w-xs text-[13px]"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="xs">
                  <Columns3 className="size-3.5" strokeWidth={1.75} />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Show columns
                </DropdownMenuLabel>
                {table
                  .getAllLeafColumns()
                  .filter((c) => c.getCanHide())
                  .map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.id}
                      checked={c.getIsVisible()}
                      onCheckedChange={(v) => c.toggleVisibility(Boolean(v))}
                    >
                      {typeof c.columnDef.header === 'string'
                        ? c.columnDef.header
                        : c.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="tabular ml-auto text-xs text-muted-foreground">
              {table.getRowModel().rows.length} of {rows.length}
            </span>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-border">
            <table
              className="w-full border-collapse text-[13px]"
              style={{ width: table.getTotalSize() }}
            >
              <thead className="sticky top-0 z-10 bg-background">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-border">
                    {hg.headers.map((header) => (
                      <th
                        key={header.id}
                        style={{ width: header.getSize() }}
                        className={
                          'relative h-9 border-r border-border/60 px-2 text-left align-middle font-medium text-muted-foreground last:border-r-0' +
                          (header.column.id === 'name'
                            ? ' sticky left-0 z-20 bg-background'
                            : '')
                        }
                      >
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="flex w-full items-center gap-1 truncate rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <span className="truncate">
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                          </span>
                          {header.column.getIsSorted() === 'asc' ? (
                            <ArrowUp className="size-3 shrink-0 text-primary" />
                          ) : header.column.getIsSorted() === 'desc' ? (
                            <ArrowDown className="size-3 shrink-0 text-primary" />
                          ) : null}
                        </button>
                        <span
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          className="absolute top-0 right-0 h-full w-1 cursor-col-resize select-none hover:bg-primary/40"
                          aria-hidden
                        />
                      </th>
                    ))}
                    <th className="w-10 px-1">
                      <AttributeCreateDialog
                        objectKind="company"
                        onCreated={() => router.invalidate()}
                        trigger={
                          <button
                            aria-label="Add column"
                            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                          >
                            <Plus className="size-3.5" strokeWidth={2} />
                          </button>
                        }
                      />
                    </th>
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="group h-9 border-b border-border/60 last:border-b-0 hover:bg-accent/50"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        style={{ width: cell.column.getSize() }}
                        className={
                          'border-r border-border/40 px-1 align-middle last:border-r-0' +
                          (cell.column.id === 'name'
                            ? ' sticky left-0 z-10 bg-background group-hover:bg-accent'
                            : '')
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                    <td className="w-10" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
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
      const result = await createCompany({
        data: {
          name: name.trim() || undefined,
          domain: domain.trim() || undefined,
        },
      })
      const patch = Object.fromEntries(
        Object.entries(values).filter(([, v]) => v !== null && v !== undefined),
      )
      if (result.action === 'created' && Object.keys(patch).length > 0) {
        await updateRecord({ data: { id: result.entityId, patch } })
      }
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
      router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the company.')
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>
            Domain is the strongest identity — add it when you know it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
            <div key={def.slug} className="space-y-1.5">
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
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
