import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { Handshake, Kanban, Plus, Table2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { ViewBar } from '#/components/views/view-bar'
import { useViewState } from '#/components/views/use-view-state'
import { matchesConditions } from '#/lib/views/filter'
import { DealBoard } from '#/components/deal-board'
import {
  fieldSpanClass,
  liveOptions,
  optionLabel,
  ValueEditor,
} from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { EmptyState } from '#/components/empty-state'
import { TemplatePicker } from '#/components/templates'
import { IconBadge, RecordLinkCell } from '#/components/table/cells'
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
import {
  createDeal,
  dealFunnelStats,
  getSession,
  listDealsTable,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/deals')({
  validateSearch: z.object({ view: z.string().optional() }),
  loader: async () => {
    const [deals, registry, funnel, viewData, session] = await Promise.all([
      listDealsTable(),
      listRegistry({ data: { kind: 'deal' } }),
      dealFunnelStats(),
      listViews({ data: { kind: 'deal' } }),
      getSession(),
    ])
    return {
      deals,
      registry,
      funnel,
      views: viewData.views,
      objectId: viewData.objectId,
      me: session?.user ?? null,
    }
  },
  component: DealsPage,
})

const GROUP_LABELS: Record<string, string> = {
  active: 'Active',
  parked: 'Parked',
  closed: 'Closed',
}

type DealRow = {
  id: string
  name: string
  values: Record<string, unknown>
  createdAt: string
}

const col = createColumnHelper<DealRow>()
const PREFS_KEY = 'dealos.deals-table.v1'

/**
 * What a column sorts and filters *on*. Sorting a status column by its stored
 * option id would order deals by an opaque slug, and sorting a reference by
 * uuid is worse — both read as "sorting is broken". Every attribute type
 * resolves to the string the user can actually see in the cell.
 */
function lookupName(
  refNames: Record<string, { name: string } | string | undefined>,
  id: string,
): string {
  const hit = refNames[id]
  if (!hit) return ''
  return typeof hit === 'string' ? hit : hit.name
}

function sortValue(
  def: RegistryEntry,
  raw: unknown,
  refNames: Record<string, { name: string } | string | undefined>,
): string | number {
  if (raw == null) return ''
  switch (def.type) {
    case 'select':
    case 'status':
      return optionLabel(def, raw)
    case 'multi_select':
      return Array.isArray(raw)
        ? raw.map((id) => optionLabel(def, id)).join(', ')
        : optionLabel(def, raw)
    case 'record_reference':
    case 'actor_reference': {
      const ids = Array.isArray(raw) ? raw : [raw]
      return ids.map((id) => lookupName(refNames, String(id))).join(', ')
    }
    case 'number':
    case 'currency':
    case 'rating':
      return typeof raw === 'number' ? raw : Number(raw)
    default:
      return String(raw)
  }
}

function DealsPage() {
  const { deals, registry, funnel, views, objectId, me } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [globalFilter, setGlobalFilter] = useState('')
  const prefs = useTablePrefs(PREFS_KEY)
  const { view: activeId } = Route.useSearch()
  const vs = useViewState<{ group: string | null; stage: string | null }>({
    views,
    activeId: activeId ?? null,
    columnVisibility: prefs.columnVisibility,
    setColumnVisibility: prefs.setColumnVisibility,
    defaultExtra: { group: 'active', stage: null },
  })
  const { sorting, setSorting } = vs
  const typeOf = useCallback(
    (slug: string) => registry.find((d) => d.slug === slug)?.type,
    [registry],
  )
  // Stage filter: group chips (Active/Parked/Closed) + per-stage narrowing.
  // Lives in the view's `extra`, so a saved view remembers the chips.
  const groupFilter = vs.extra.group
  const stageFilter = vs.extra.stage
  const { setExtra } = vs
  const setGroupFilter = useCallback(
    (group: string | null) => setExtra((e) => ({ ...e, group })),
    [setExtra],
  )
  const setStageFilter = useCallback(
    (stage: string | null) => setExtra((e) => ({ ...e, stage })),
    [setExtra],
  )
  const selectView = (id: string | null) =>
    void navigate({ to: '/deals', search: { view: id ?? undefined } })
  // View toggle — read post-mount so SSR and client agree on first paint.
  const [view, setView] = useState<'table' | 'board'>('table')
  useEffect(() => {
    if (localStorage.getItem('dealos.deals-view') === 'board') setView('board')
  }, [])
  function switchView(v: 'table' | 'board') {
    setView(v)
    localStorage.setItem('dealos.deals-view', v)
  }

  const stageDef = registry.find((d) => d.slug === 'stage') as
    RegistryEntry | undefined
  const stageOptions = useMemo(
    () => stageDef?.options?.options ?? [],
    [stageDef],
  )

  const refNames = useMemo(
    () => ({
      ...deals.refNames,
      ...Object.fromEntries(
        Object.entries(deals.userNames).map(([id, name]) => [id, { name }]),
      ),
    }),
    [deals],
  )

  // Stage narrowing runs before the table so the chips stay an independent
  // control; free-text filtering is the table's own, as on every other surface.
  const staged = useMemo(() => {
    return deals.rows.filter((d) => {
      if (!matchesConditions(d.values, vs.conditions, typeOf)) return false
      const stage = String(d.values.stage ?? '')
      const opt = stageOptions.find((o) => o.id === stage)
      if (stageFilter) return stage === stageFilter
      if (groupFilter) return (opt?.group ?? 'active') === groupFilter
      return true
    })
  }, [deals, groupFilter, stageFilter, stageOptions, vs.conditions, typeOf])

  // Counts per group for the filter chips.
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { active: 0, parked: 0, closed: 0 }
    for (const d of deals.rows) {
      const opt = stageOptions.find(
        (o) => o.id === String(d.values.stage ?? ''),
      )
      counts[opt?.group ?? 'active'] += 1
    }
    return counts
  }, [deals, stageOptions])

  useEffect(() => {
    // Narrowed stage must belong to the selected group.
    if (!stageFilter) return
    const opt = stageOptions.find((o) => o.id === stageFilter)
    if (groupFilter && opt && (opt.group ?? 'active') !== groupFilter)
      setStageFilter(null)
  }, [groupFilter, stageFilter, stageOptions, setStageFilter])

  const saveCell = useCallback(
    async (id: string, slug: string, value: unknown) => {
      try {
        await updateRecord({ data: { id, patch: { [slug]: value } } })
        void router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not save')
        void router.invalidate()
      }
    },
    [router],
  )

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<DealRow, unknown>> = [
      col.accessor('name', {
        id: 'name',
        header: 'Deal',
        size: 240,
        enableHiding: false,
        cell: (info) => (
          <RecordLinkCell
            to="/deals/$dealId"
            params={{ dealId: info.row.original.id }}
            name={String(info.getValue())}
            badge={<IconBadge icon={Handshake} />}
          />
        ),
      }),
      ...registry.map(
        (def) =>
          col.accessor(
            (r) =>
              sortValue(def as RegistryEntry, r.values[def.slug], refNames),
            {
              id: `attr:${def.slug}`,
              header: def.name,
              size: def.type === 'text' ? 200 : 140,
              sortUndefined: 'last',
              cell: (info) => (
                <ValueEditor
                  def={def as RegistryEntry}
                  value={info.row.original.values[def.slug] ?? null}
                  variant="cell"
                  refNames={refNames}
                  onSave={(v) => saveCell(info.row.original.id, def.slug, v)}
                />
              ),
            },
          ) as ColumnDef<DealRow, unknown>,
      ),
    ]
    return defs
  }, [registry, refNames, saveCell])

  const table = useReactTable({
    data: staged,
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
      const companyId = row.original.values.company as string | undefined
      const companyName = companyId ? lookupName(deals.refNames, companyId) : ''
      return (
        row.original.name.toLowerCase().includes(q) ||
        companyName.toLowerCase().includes(q)
      )
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange',
  })

  return (
    <div className="flex h-full flex-col px-6 py-8 md:px-10">
      <PageHeader
        title="Deals"
        description="One record per opportunity — born at Pre-lead, closed as Invested, Passed, or Lost. History is the point."
        action={
          <CreateDealDialog registry={registry as Array<RegistryEntry>} />
        }
      />

      {deals.rows.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="No deals yet"
          body="A deal starts when something arrives — a deck, an intro, a founder email. Create one against a company and triage it from Pre-lead."
          action={
            <CreateDealDialog registry={registry as Array<RegistryEntry>} />
          }
        />
      ) : view === 'board' ? (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <ViewToggle view={view} onChange={switchView} />
            <TerminalSplit rows={deals.rows} />
          </div>
          <DealBoard
            deals={deals.rows}
            stages={stageOptions}
            refNames={refNames}
            valueCurrency={
              (
                registry.find((d) => d.slug === 'value')?.options as
                  { code?: string } | undefined
              )?.code ?? 'USD'
            }
            medianDaysInStage={funnel.medianDaysInStage}
          />
        </>
      ) : (
        <>
          <TableToolbar
            table={table}
            filter={globalFilter}
            onFilterChange={setGlobalFilter}
            filterPlaceholder="Filter by deal or company…"
            filterLabel="Filter deals"
            noun={{ one: 'deal', many: 'deals' }}
            total={deals.rows.length}
            shown={table.getRowModel().rows.length}
          >
            <ViewToggle view={view} onChange={switchView} />
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
            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="Stage group"
            >
              {(['active', 'parked', 'closed'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={groupFilter === g}
                  onClick={() => setGroupFilter(groupFilter === g ? null : g)}
                  className={cn(
                    'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-label font-medium whitespace-nowrap focus-ring transition-colors duration-150 ease-out-quart',
                    groupFilter === g
                      ? 'border-primary/40 bg-selected text-foreground'
                      : 'border-border text-muted-foreground hover:border-input hover:text-foreground',
                  )}
                >
                  {GROUP_LABELS[g]}
                  <span className="tabular">{groupCounts[g]}</span>
                </button>
              ))}
            </div>
            {groupFilter ? (
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label={`${GROUP_LABELS[groupFilter]} stages`}
              >
                {stageOptions
                  .filter((o) => (o.group ?? 'active') === groupFilter)
                  .filter((o) => !o.archived)
                  .map((o) => (
                    <StageChip
                      key={o.id}
                      option={o}
                      pressed={stageFilter === o.id}
                      onToggle={() =>
                        setStageFilter(stageFilter === o.id ? null : o.id)
                      }
                    />
                  ))}
                {/* Filtering is reading history, so retired stages stay
                    filterable behind a divider — that's how the records
                    still parked on one get found and retagged (spec §3). */}
                {stageOptions.some(
                  (o) => o.archived && (o.group ?? 'active') === groupFilter,
                ) ? (
                  <>
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      className="mx-1 flex h-4 items-center self-center border-l border-border pl-2 text-micro font-medium tracking-wide text-muted-foreground uppercase"
                    >
                      Archived
                    </span>
                    {stageOptions
                      .filter((o) => (o.group ?? 'active') === groupFilter)
                      .filter((o) => o.archived)
                      .map((o) => (
                        <StageChip
                          key={o.id}
                          option={o}
                          pressed={stageFilter === o.id}
                          onToggle={() =>
                            setStageFilter(stageFilter === o.id ? null : o.id)
                          }
                        />
                      ))}
                  </>
                ) : null}
              </div>
            ) : null}
          </TableToolbar>
          <RecordTable
            table={table}
            label="Deals"
            stickyColumnId="name"
            addColumn={
              <AttributeCreateDialog
                objectKind="deal"
                onCreated={() => router.invalidate()}
                trigger={<AddColumnButton />}
              />
            }
          />
        </>
      )}
    </div>
  )
}

function StageChip({
  option,
  pressed,
  onToggle,
}: {
  option: { id: string; label: string; archived?: boolean }
  pressed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      title={option.archived ? 'Archived option' : undefined}
      className={cn(
        'h-7 shrink-0 rounded-full border px-2.5 text-label whitespace-nowrap focus-ring transition-colors duration-150 ease-out-quart',
        pressed
          ? 'border-primary/40 bg-selected font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
        option.archived && !pressed && 'opacity-70',
      )}
    >
      {option.label}
    </button>
  )
}

/**
 * The all-time terminal split — our-no vs their-no is the post-mortem
 * doctrine's headline number, so it sits above the funnel.
 */
function TerminalSplit({ rows }: { rows: Array<DealRow> }) {
  const counts = { invested: 0, passed: 0, lost: 0 }
  for (const d of rows) {
    const s = String(d.values.stage ?? '')
    if (s === 'invested' || s === 'passed' || s === 'lost') counts[s] += 1
  }
  return (
    <span className="tabular text-label text-muted-foreground">
      {rows.length} deals · {counts.invested} invested · {counts.passed} passed
      · {counts.lost} lost
    </span>
  )
}

function ViewToggle({
  view,
  onChange,
}: {
  view: 'table' | 'board'
  onChange: (v: 'table' | 'board') => void
}) {
  return (
    <div
      role="group"
      aria-label="View"
      className="flex items-center rounded-md border border-border p-0.5"
    >
      {(
        [
          ['table', Table2, 'Table'],
          ['board', Kanban, 'Board'],
        ] as const
      ).map(([v, Icon, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onChange(v)}
          className={cn(
            'flex h-6 items-center gap-1 rounded px-2 text-label focus-ring transition-colors duration-150',
            view === v
              ? 'bg-selected font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  )
}

export function CreateDealDialog({
  registry,
  presetCompany,
  triggerLabel = 'New deal',
}: {
  registry: Array<RegistryEntry>
  presetCompany?: { id: string; name: string }
  triggerLabel?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [companyId, setCompanyId] = useState<string | null>(
    presetCompany?.id ?? null,
  )
  const [companyName, setCompanyName] = useState(presetCompany?.name ?? '')
  const companyDef = registry.find((d) => d.slug === 'company')
  const stageDef = registry.find((d) => d.slug === 'stage')
  // Born on the first live stage: a retired Pre-lead would be rejected.
  const [stage, setStage] = useState<string>(
    () =>
      (stageDef ? liveOptions(stageDef).at(0)?.id : undefined) ?? 'pre_lead',
  )
  const [values, setValues] = useState<Record<string, unknown>>({})
  // The judgment fields worth setting at birth; refs and owner stay on the
  // record page.
  const extraDefs = registry.filter((d) =>
    ['value', 'source', 'close_date'].includes(d.slug),
  )

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!companyId) return setError('Pick the company — a deal needs one.')
    const dealName = name.trim() || `${companyName || 'New'} deal`
    setPending(true)
    try {
      const { id } = await createDeal({
        data: {
          companyId,
          name: dealName,
          stage,
          value: typeof values.value === 'number' ? values.value : undefined,
          source: typeof values.source === 'string' ? values.source : undefined,
        },
      })
      if (values.close_date != null) {
        await updateRecord({
          data: { id, patch: { close_date: values.close_date } },
        })
      }
      setOpen(false)
      setName('')
      setValues({})
      if (!presetCompany) {
        setCompanyId(null)
        setCompanyName('')
      }
      toast(`${dealName} created`)
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the deal')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
          <DialogDescription>
            One opportunity in one company. It starts at Pre-lead.
          </DialogDescription>
        </DialogHeader>
        {/* Pre-fills the fields below, visibly and editably — never writes. */}
        <div className="flex justify-end">
          <TemplatePicker
            kind="record"
            objectKind="deal"
            context="deal"
            onPick={(t) => {
              const tv = (t.body as { values?: Record<string, unknown> }).values
              if (!tv) return
              if (typeof tv.stage === 'string') setStage(tv.stage)
              setValues((s) => ({ ...tv, ...s }))
            }}
          />
        </div>
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
        >
          {companyDef && !presetCompany ? (
            <div className="space-y-1.5">
              <Label>Company</Label>
              <ValueEditor
                def={companyDef}
                value={companyId}
                variant="field"
                refNames={
                  companyId ? { [companyId]: { name: companyName } } : {}
                }
                onSave={(v) => setCompanyId(v as string | null)}
              />
              <CompanyNameCapture
                companyId={companyId}
                onName={(n) => {
                  setCompanyName(n)
                  setName((cur) => (cur.trim() ? cur : `${n} deal`))
                }}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="deal-name">Name</Label>
            <Input
              id="deal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                companyName ? `${companyName} deal` : 'Pixxel — Series B'
              }
            />
          </div>
          {stageDef ? (
            <div className="space-y-1.5">
              <Label>Stage</Label>
              <ValueEditor
                def={stageDef}
                value={stage}
                variant="field"
                onSave={(v) => setStage(String(v ?? 'pre_lead'))}
              />
            </div>
          ) : null}

          {extraDefs.map((def) => (
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
              {pending ? 'Creating…' : 'Create deal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Resolves a picked company id to its name for auto-naming the deal. */
function CompanyNameCapture({
  companyId,
  onName,
}: {
  companyId: string | null
  onName: (name: string) => void
}) {
  useEffect(() => {
    if (!companyId) return
    let alive = true
    void import('#/lib/server-fns').then(async ({ getCompany }) => {
      try {
        const c = await getCompany({ data: { id: companyId } })
        if (alive) onName(c.name)
      } catch {
        /* name stays blank; user types one */
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])
  return null
}
