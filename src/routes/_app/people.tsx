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
  AtSign,
  Building2,
  Columns3,
  Plus,
  Users,
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
  createPerson,
  listCompanies,
  listPeopleTable,
  listRegistry,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/people')({
  loader: async () => {
    const [rows, registry, companies] = await Promise.all([
      listPeopleTable(),
      listRegistry({ data: { kind: 'person' } }),
      listCompanies(),
    ])
    return { rows, registry, companies }
  },
  component: PeoplePage,
})

type Row = Awaited<ReturnType<typeof listPeopleTable>>[number]

const col = createColumnHelper<Row>()
const PREFS_KEY = 'dealos.people-table.v1'

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

function PeoplePage() {
  const { rows, registry, companies } = Route.useLoaderData()
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
      router.invalidate()
    }
  }

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<Row, unknown>> = [
      col.accessor('name', {
        id: 'name',
        header: 'Person',
        size: 200,
        enableHiding: false,
        cell: (info) => (
          <Link
            to="/people/$personId"
            params={{ personId: info.row.original.id }}
            className="flex h-full min-w-0 items-center gap-2 px-1 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
              {String(info.getValue()).charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{info.getValue()}</span>
          </Link>
        ),
      }) as ColumnDef<Row, unknown>,
      col.accessor((r) => r.emails.join(', '), {
        id: 'emails',
        header: 'Email',
        size: 200,
        cell: (info) =>
          info.row.original.emails.length > 0 ? (
            <span className="flex items-center gap-1.5 truncate px-1 text-muted-foreground">
              <AtSign className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate">
                {info.row.original.emails.join(', ')}
              </span>
            </span>
          ) : null,
      }) as ColumnDef<Row, unknown>,
      col.accessor((r) => r.company?.name ?? '', {
        id: 'company',
        header: 'Company',
        size: 170,
        cell: (info) =>
          info.row.original.company ? (
            <Link
              to="/companies/$companyId"
              params={{ companyId: info.row.original.company.id }}
              className="flex items-center gap-1 truncate rounded-full bg-muted px-2 py-0.5 text-xs font-medium hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Building2 className="size-2.5 shrink-0" strokeWidth={1.75} />
              <span className="truncate">{info.row.original.company.name}</span>
            </Link>
          ) : null,
      }) as ColumnDef<Row, unknown>,
      ...registry.map(
        (def) =>
          col.accessor((r) => r.values[def.slug] ?? null, {
            id: `attr:${def.slug}`,
            header: def.name,
            size: def.type === 'text' ? 180 : 140,
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
      col.accessor((r) => r.lastTouched ?? '', {
        id: 'lastTouched',
        header: 'Last touched',
        size: 120,
        sortUndefined: 'last',
        cell: (info) =>
          info.row.original.lastTouched ? (
            <span className="tabular block px-1 text-right text-xs text-muted-foreground/80">
              {dateFmt.format(new Date(info.row.original.lastTouched))}
            </span>
          ) : null,
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
        row.original.emails.some((e) => e.includes(q)) ||
        (row.original.company?.name.toLowerCase().includes(q) ?? false)
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
          <h1 className="text-[22px] font-semibold tracking-tight">People</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Founders, operators, co-investors — deduped by email, linked to
            their companies.
          </p>
        </div>
        <CreatePersonDialog companies={companies} />
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No people yet"
          body="Add someone by name and email. Email is identity — the same person arriving from two directions becomes one record."
          action={<CreatePersonDialog companies={companies} />}
          hint="Gmail and calendar sync will create these automatically later — through the same dedupe gate."
        />
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Filter by name, email, company…"
              aria-label="Filter people"
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
                        objectKind="person"
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

function CreatePersonDialog({
  companies,
}: {
  companies: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

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
      const result = await createPerson({
        data: {
          name,
          email: email || undefined,
          companyId: companyId || undefined,
        },
      })
      setOpen(false)
      if (result.action === 'attached') {
        toast(`Matched existing person — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      } else {
        toast(`${result.name} added`)
      }
      router.invalidate()
    } catch {
      setError('Could not add the person.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          New person
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
          <DialogDescription>
            Email is the strongest identity — add it when you have it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
            <select
              id="person-company"
              name="company"
              defaultValue=""
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="">None</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add person'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
