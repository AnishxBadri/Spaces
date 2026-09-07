import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { Layers, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
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
  PageHeader,
  RecordTable,
  TableToolbar,
} from '#/components/table/record-table'
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
import { objectIcon } from '#/lib/object-icons'
import {
  createObjectRecord,
  getObject,
  listObjectRecords,
  listRegistry,
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
  loader: async ({ params }) => {
    const object = await getObject({ data: { slug: params.objectSlug } })
    // An archived object hides its routes (§9 lifecycle); records persist.
    if (object.archived || object.isSystem) throw notFound()
    const [registry, table] = await Promise.all([
      listRegistry({ data: { objectId: object.id } }),
      listObjectRecords({ data: { objectId: object.id } }),
    ])
    return { object, registry, rows: table.rows, refNames: table.refNames }
  },
  component: ObjectListPage,
})

type Row = Awaited<ReturnType<typeof listObjectRecords>>['rows'][number]
const col = createColumnHelper<Row>()

function ObjectListPage() {
  const { object, registry, rows, refNames } = Route.useLoaderData()
  const router = useRouter()
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const prefs = useTablePrefs(`dealos.o-${object.slug}-table.v1`)
  const Icon = objectIcon(object)

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
                refNames={refNames}
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

  const table = useReactTable({
    data: rows,
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
        row.original.spaces.some((s) => s.name.toLowerCase().includes(q)) ||
        Object.values(row.original.values).some(
          (v) => typeof v === 'string' && v.toLowerCase().includes(q),
        )
      )
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange',
  })

  const createDialog = (
    <CreateRecordDialog
      object={object}
      registry={registry as Array<RegistryEntry>}
      refNames={refNames}
    />
  )
  const noun = {
    one: object.singular.toLowerCase(),
    many: object.plural.toLowerCase(),
  }

  return (
    <div className="flex h-full flex-col px-6 py-8 md:px-10">
      <PageHeader
        title={object.plural}
        description={`Every ${noun.one} you keep — your own object, your own attributes.`}
        action={createDialog}
      />

      {rows.length === 0 ? (
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
            total={rows.length}
            shown={table.getRowModel().rows.length}
          />
          <RecordTable
            table={table}
            label={object.plural}
            stickyColumnId="name"
            addColumn={
              <AttributeDialog
                mode="create"
                objectId={object.id}
                objectLabel={object.singular}
                onSaved={() => router.invalidate()}
                trigger={<AddColumnButton />}
              />
            }
          />
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
}: {
  object: { id: string; singular: string; plural: string }
  registry: Array<RegistryEntry>
  refNames: Record<string, { name: string }>
}) {
  const router = useRouter()
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
      await createObjectRecord({
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
      toast(`${name.trim()} added`)
      void router.invalidate()
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
