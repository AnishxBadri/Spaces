import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { AtSign, Building2, Plus, Users } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { ViewBar } from '#/components/views/view-bar'
import { useViewState } from '#/components/views/use-view-state'
import { matchesConditions } from '@spaces/core/views/filter'
import { cn } from '#/lib/utils'
import { jsonRecord } from '#/lib/json'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { EmptyState } from '#/components/empty-state'
import { TemplatePicker } from '#/components/templates'
import {
  ChipLink,
  DateCell,
  InitialBadge,
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
import { Select } from '#/components/ui/select'
import {
  createPerson,
  getSession,
  listCompanies,
  listPeopleTable,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/people')({
  validateSearch: z.object({ view: z.string().optional() }),
  loader: async () => {
    const [rows, registry, companies, viewData, session] = await Promise.all([
      listPeopleTable(),
      listRegistry({ data: { kind: 'person' } }),
      listCompanies(),
      listViews({ data: { kind: 'person' } }),
      getSession(),
    ])
    return {
      rows,
      registry,
      companies,
      views: viewData.views,
      objectId: viewData.objectId,
      me: session?.user ?? null,
    }
  },
  component: PeoplePage,
})

type Row = Awaited<ReturnType<typeof listPeopleTable>>[number]

const col = createColumnHelper<Row>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'dealos.people-table.v1'

function PeoplePage() {
  const { rows, registry, companies, views, objectId, me } =
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
    void navigate({ to: '/people', search: id === null ? {} : { view: id } })

  async function saveCell(entityId: string, slug: string, value: unknown) {
    try {
      await updateRecord({ data: { id: entityId, patch: { [slug]: value } } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      void router.invalidate()
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
          <RecordLinkCell
            to="/people/$personId"
            params={{ personId: info.row.original.id }}
            name={String(info.getValue())}
            badge={<InitialBadge name={String(info.getValue())} />}
          />
        ),
      }),
      col.accessor((r) => r.emails.join(', '), {
        id: 'emails',
        header: 'Email',
        size: 200,
        cell: (info) =>
          info.row.original.emails.length > 0 ? (
            <MetaCell icon={AtSign}>
              {info.row.original.emails.join(', ')}
            </MetaCell>
          ) : null,
      }),
      col.accessor((r) => r.company?.name ?? '', {
        id: 'company',
        header: 'Company',
        size: 170,
        cell: (info) =>
          info.row.original.company ? (
            <span className="flex px-1">
              <ChipLink
                to="/companies/$companyId"
                params={{ companyId: info.row.original.company.id }}
                icon={Building2}
                label={info.row.original.company.name}
              />
            </span>
          ) : null,
      }),
      ...registry.map((def) =>
        col.accessor((r): unknown => r.values[def.slug] ?? null, {
          id: `attr:${def.slug}`,
          header: def.name,
          size: def.type === 'text' ? 180 : 140,
          sortUndefined: 'last',
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
    <div className="flex h-full flex-col">
      <PageHeader
        title="People"
        description="Founders, operators, co-investors — deduped by email, linked to their companies."
        action={
          <CreatePersonDialog companies={companies} registry={registry} />
        }
      />
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        {rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No people yet"
            body="Add someone by name and email. Email is identity — the same person arriving from two directions becomes one record."
            action={
              <CreatePersonDialog companies={companies} registry={registry} />
            }
            hint="Gmail and calendar sync will create these automatically later — through the same dedupe gate."
          />
        ) : (
          <>
            <TableToolbar
              table={table}
              filter={globalFilter}
              onFilterChange={setGlobalFilter}
              filterPlaceholder="Filter by name, email, company…"
              filterLabel="Filter people"
              noun={{ one: 'person', many: 'people' }}
              total={rows.length}
              shown={table.getRowModel().rows.length}
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
                onSaved={() => router.invalidate()}
                canEdit={(v) => v.createdBy === me?.id || me?.role === 'admin'}
              />
            </TableToolbar>
            <RecordTable
              table={table}
              label="People"
              stickyColumnId="name"
              addColumn={
                <AttributeCreateDialog
                  objectKind="person"
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

function CreatePersonDialog({
  companies,
  registry,
}: {
  companies: Array<{ id: string; name: string }>
  registry: Array<RegistryEntry>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  // Still submitted through `FormData` — the picker mirrors its value into a
  // hidden `company` input, so the submit path below is untouched.
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
          <DialogDescription>
            Email is the strongest identity — add it when you have it.
          </DialogDescription>
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
              {pending ? 'Adding\u2026' : 'Create person'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
