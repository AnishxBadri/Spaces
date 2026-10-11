import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { Handshake, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { ViewBar } from '#/components/views/view-bar'
import { useViewState } from '#/components/views/use-view-state'
import { useColumnRun } from '#/components/views/column-run'
import { matchesConditions } from '@spaces/core/views/filter'
import { DealBoard } from '#/components/deal-board'
import {
  fieldSpanClass,
  liveOptions,
  optionLabel,
  ValueEditor,
} from '#/components/attributes/value-editor'
import { AiCell, AiCellsProvider } from '#/components/attributes/ai-cell'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { EmptyState } from '#/components/empty-state'
import { TemplatePicker } from '#/components/templates'
import {
  attributeColumnMeta,
  IconBadge,
  RecordLinkCell,
} from '#/components/table/cells'
import {
  AddColumnButton,
  RecordTable,
  TableTools,
} from '#/components/table/record-table'
import { ListMenu } from '#/components/table/list-menu'
import { FilterCount, FilterRow, FilterTab } from '#/components/filter-row'
import { KeyHint, PageHeader } from '#/components/page-header'
import { ImportAction } from '#/components/import/import-action'
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
import {
  countViews,
  createDeal,
  dealFunnelStats,
  getSession,
  listDealsTable,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { useHotkey } from '#/lib/use-hotkey'
import { jsonRecord, jsonString } from '@spaces/core/json'
import type { EntityValues } from '@spaces/db/schema/entities'

/**
 * **This board does not page, and that is a decision, not an omission
 * (SPA-96).**
 *
 * The company, people and custom-object lists all take views-3's keyset
 * contract: the server cuts a page, counts the matching set, and the grid
 * holds only what it asked for. This board cannot. It groups by stage on the
 * client and draws a chip per group whose count is over **every** deal — and
 * the stage narrowing itself moves rows between those groups. A page would
 * make every chip a claim about the fifty rows that happened to load while
 * reading as a claim about the pipeline, which is the one number a partner
 * looks at first. `matchesConditions` therefore stays here, filtering rows
 * this loader really does hold.
 *
 * The exit, when the pipeline outgrows one fetch, is a grouped server read —
 * counts per stage in SQL plus a page per group — not this loader with a
 * `limit` bolted on. (Portfolio stays whole for the sibling reason: its
 * metrics are summed across all holdings.)
 */
export const Route = createFileRoute('/_app/deals')({
  validateSearch: z.object({ view: z.string().optional() }),
  loader: async () => {
    const [deals, registry, funnel, viewData, session] = await Promise.all([
      listDealsTable(),
      listRegistry({ data: { kind: 'deal' } }),
      dealFunnelStats(),
      listViews({ data: { surface: 'object', kind: 'deal' } }),
      getSession(),
    ])
    // Every chip's count (SPA-162): the view's conditions, in SQL, over the
    // same set `listDealsTable` loads. The group/stage chips a view keeps in
    // `extra` are this board's own narrowing and are not a view condition,
    // so the chip counts what the view's filter holds, as on every list.
    const counts = await countViews({
      data: {
        surface: 'object',
        kind: 'deal',
        viewIds: viewData.views.map((v) => v.id),
      },
    })
    return {
      deals,
      registry,
      funnel,
      views: viewData.views,
      counts,
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
  values: EntityValues
  createdAt: string
}

const col = createColumnHelper<DealRow>()
// FROZEN: renaming resets saved column layouts with no recovery path.
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
  const {
    deals,
    registry,
    funnel,
    views,
    counts: viewCounts,
    objectId,
    me,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [globalFilter, setGlobalFilter] = useState('')
  const prefs = useTablePrefs(PREFS_KEY)
  const { view: activeId } = Route.useSearch()
  // SPA-122: "Run on this view" in an AI attribute's column header.
  const columnRun = useColumnRun({
    viewId: views.find((v) => v.id === activeId)?.id ?? null,
    registry,
  })
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
    void navigate({ to: '/deals', search: id === null ? {} : { view: id } })
  // View toggle — read post-mount so SSR and client agree on first paint.
  const [view, setView] = useState<'table' | 'board'>('table')
  useEffect(() => {
    // FROZEN: renaming resets saved view preference with no recovery path.
    if (localStorage.getItem('dealos.deals-view') === 'board') setView('board')
  }, [])
  function switchView(v: 'table' | 'board') {
    setView(v)
    localStorage.setItem('dealos.deals-view', v)
  }

  const stageDef = registry.find((d) => d.slug === 'stage')
  const stageOptions = useMemo(
    () => stageDef?.options.options ?? [],
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

  // Counts per group and per stage for the filter row — over every deal,
  // which is why this surface holds them all (see the note on the route).
  const { groupCounts, stageCounts } = useMemo(() => {
    const groups: Record<string, number> = { active: 0, parked: 0, closed: 0 }
    const stages = new Map<string, number>()
    for (const d of deals.rows) {
      const stage = String(d.values.stage ?? '')
      const opt = stageOptions.find((o) => o.id === stage)
      groups[opt?.group ?? 'active'] += 1
      stages.set(stage, (stages.get(stage) ?? 0) + 1)
    }
    return { groupCounts: groups, stageCounts: stages }
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
      ...registry.map((def) =>
        col.accessor(
          (r): unknown => sortValue(def, r.values[def.slug], refNames),
          {
            id: `attr:${def.slug}`,
            header: def.name,
            size: def.type === 'text' ? 200 : 140,
            meta: attributeColumnMeta(def.type),
            sortUndefined: 'last',
            cell: (info) => (
              <AiCell def={def} entityId={info.row.original.id}>
                <ValueEditor
                  def={def}
                  value={info.row.original.values[def.slug] ?? null}
                  variant="cell"
                  refNames={refNames}
                  onSave={(v) => saveCell(info.row.original.id, def.slug, v)}
                />
              </AiCell>
            ),
          },
        ),
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
      const companyId = jsonString(row.original.values.company)
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

  const groupStages =
    groupFilter === null
      ? []
      : stageOptions.filter((o) => (o.group ?? 'active') === groupFilter)
  const stageTab = (o: { id: string; label: string; archived?: boolean }) => (
    <FilterTab
      key={o.id}
      active={stageFilter === o.id}
      onClick={() => setStageFilter(stageFilter === o.id ? null : o.id)}
    >
      {o.label} <FilterCount n={stageCounts.get(o.id) ?? 0} />
    </FilterTab>
  )

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Deals"
        count={deals.rows.length}
        action={
          <>
            <ImportAction objectSlug="deals" />
            <CreateDealDialog registry={registry} hotkey="c" />
            <ListMenu
              label="Deals"
              verbs={[
                view === 'board'
                  ? {
                      label: 'Show as table',
                      onSelect: () => switchView('table'),
                    }
                  : {
                      label: 'Show as board',
                      onSelect: () => switchView('board'),
                    },
              ]}
            />
          </>
        }
      />
      {deals.rows.length === 0 ? (
        <div className="px-8 pb-8">
          <EmptyState
            icon={Handshake}
            title="No deals yet"
            body="A deal starts when something arrives — a deck, an intro, a founder email. Create one against a company and triage it from Pre-lead."
            action={<CreateDealDialog registry={registry} />}
          />
        </div>
      ) : view === 'board' ? (
        <div className="px-8 pb-8">
          <div className="mb-4 flex h-9 items-center justify-between gap-3 border-b border-rule">
            <TerminalSplit rows={deals.rows} />
            <span className="mono text-micro text-graphite">drag to move</span>
          </div>
          <DealBoard
            deals={deals.rows}
            stages={stageOptions}
            refNames={refNames}
            valueCurrency={
              registry.find((d) => d.slug === 'value')?.options.code ?? 'USD'
            }
            pictures={deals.pictures}
            medianDaysInStage={funnel.medianDaysInStage}
            daysInStage={Object.fromEntries(
              funnel.daysInStage.map((d) => [d.id, d.days]),
            )}
          />
        </div>
      ) : (
        <>
          <ViewBar
            objectId={objectId}
            registry={registry}
            views={views}
            counts={viewCounts}
            total={deals.rows.length}
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
            tools={
              <TableTools
                table={table}
                filter={globalFilter}
                onFilterChange={setGlobalFilter}
                filterPlaceholder="Filter by deal or company…"
                filterLabel="Filter deals"
              />
            }
          />
          <div className="px-8 pb-8">
            {/* The view's own narrowing, saved in its `extra`: a group, then
                one of its stages. Retired stages stay filterable after the
                divider — that is how the deals still parked on one are found
                and retagged. */}
            <FilterRow label="Stage">
              {(['active', 'parked', 'closed'] as const).map((g) => (
                <FilterTab
                  key={g}
                  active={groupFilter === g}
                  onClick={() => setGroupFilter(groupFilter === g ? null : g)}
                >
                  {GROUP_LABELS[g]} <FilterCount n={groupCounts[g]} />
                </FilterTab>
              ))}
              {groupStages.length > 0 ? (
                <span
                  aria-hidden
                  className="mx-2 h-4 self-center border-l border-rule"
                />
              ) : null}
              {groupStages.filter((o) => !o.archived).map(stageTab)}
              {groupStages.some((o) => o.archived) ? (
                <>
                  <span className="mr-1 ml-3 self-center label-caps text-graphite">
                    Archived
                  </span>
                  {groupStages.filter((o) => o.archived).map(stageTab)}
                </>
              ) : null}
            </FilterRow>
            <AiCellsProvider
              entityIds={table.getRowModel().rows.map((r) => r.original.id)}
              registry={registry}
            >
              <RecordTable
                columnActions={columnRun.columnActions}
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
            </AiCellsProvider>
          </div>
          {columnRun.dialog}
        </>
      )}
    </div>
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
    <span className="mono text-micro text-graphite">
      {rows.length} deals · {counts.invested} invested · {counts.passed} passed
      · {counts.lost} lost
    </span>
  )
}

export function CreateDealDialog({
  registry,
  presetCompany,
  triggerLabel = 'New deal',
  trigger,
  hotkey,
}: {
  registry: Array<RegistryEntry>
  presetCompany?: { id: string; name: string }
  triggerLabel?: string
  /** A trigger of the caller's own — must forward props (plain DOM elements do). */
  trigger?: React.ReactNode
  /** Bare key that opens it from the page — printed in the default trigger. */
  hotkey?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
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
        {trigger ?? (
          <Button size="sm">
            <Plus className="size-4" strokeWidth={2} />
            {triggerLabel}
            {hotkey ? <KeyHint>{hotkey.toUpperCase()}</KeyHint> : null}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
        </DialogHeader>
        {/* Pre-fills the fields below, visibly and editably — never writes. */}
        <div className="flex justify-end">
          <TemplatePicker
            kind="record"
            objectKind="deal"
            context="deal"
            onPick={(t) => {
              const tv = jsonRecord(jsonRecord(t.body).values)
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
                onSave={(v) => setCompanyId(typeof v === 'string' ? v : null)}
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
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
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
