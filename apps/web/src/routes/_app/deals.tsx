import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, VisibilityState } from '@tanstack/react-table'
import { Handshake } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { ViewBar, viewBarPin } from '#/components/views/view-bar'
import { useViewState } from '#/components/views/use-view-state'
import { useColumnRun } from '#/components/views/column-run'
import { matchesConditions } from '@spaces/core/views/filter'
import { DealBoard } from '#/components/deal-board'
import type { BoardStage } from '#/components/deal-board'
import { optionLabel, ValueEditor } from '#/components/attributes/value-editor'
import { AiCell, AiCellsProvider } from '#/components/attributes/ai-cell'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { EmptyRow } from '#/components/ledger-section'
import { PIN_UNDER_HEAD_BAR } from '#/components/head-fold'
import { CreateDealDialog } from '#/components/create-deal-dialog'
import {
  attributeColumnMeta,
  IconBadge,
  RecordLinkCell,
} from '#/components/table/cells'
import {
  AddColumnButton,
  RecordTable,
  TableTools,
  ToolButton,
} from '#/components/table/record-table'
import { ListMenu } from '#/components/table/list-menu'
import { useListActions } from '#/components/table/list-actions'
import { statColumns } from '#/components/table/stat-columns'
import { PageHeader } from '#/components/page-header'
import { useImportVerb } from '#/components/import/import-action'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Segmented } from '#/components/ui/segmented'
import {
  countViews,
  dealFunnelStats,
  getSession,
  listDealsTable,
  listRegistry,
  listViews,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { jsonString } from '@spaces/core/json'

/**
 * **This list does not page, deliberately.** It groups by stage on the
 * client and the Stage chip counts **every** deal; a page would make every
 * count a claim about the rows that happened to load. So `matchesConditions`
 * filters rows this loader really holds.
 * When the pipeline outgrows one fetch, the exit is a grouped server read
 * (counts per stage plus a page per group), not a `limit` bolted on here.
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
    // Every tab's count: the view's conditions, in SQL, over the same set
    // `listDealsTable` loads. The Stage chip a view keeps in `extra` is this
    // list's own narrowing and not a view condition, so a tab counts what
    // the view's filter holds, as on every list.
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

/** The stage groups, in the order the Stage chip lists them. */
const STAGE_GROUPS = [
  { id: 'active', label: 'Active' },
  { id: 'parked', label: 'Parked' },
  { id: 'closed', label: 'Closed' },
] as const

type DealRow = Awaited<ReturnType<typeof listDealsTable>>['rows'][number]

const col = createColumnHelper<DealRow>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'dealos.deals-table.v1'
// FROZEN: renaming resets the saved Table | Board choice with no recovery path.
const SHAPE_KEY = 'dealos.deals-view'

/** The attributes the list opens on, in this order, after Deal. */
const LEAD_COLUMNS = ['stage', 'value', 'owner', 'source', 'close_date']

/**
 * Hidden until someone asks for them in Columns: the system attributes the
 * list does not open on. A custom attribute shows, as on every list.
 */
const HIDDEN_AT_FIRST: VisibilityState = {
  'attr:company': false,
  'attr:people': false,
  'attr:close_reason': false,
  'attr:referred_by': false,
}

/** Table or board, read after mount so the server and the client agree. */
function useDealsShape(): [
  'table' | 'board',
  (shape: 'table' | 'board') => void,
] {
  const [shape, setShape] = useState<'table' | 'board'>('table')
  useEffect(() => {
    if (localStorage.getItem(SHAPE_KEY) === 'board') setShape('board')
  }, [])
  return [
    shape,
    (next) => {
      setShape(next)
      localStorage.setItem(SHAPE_KEY, next)
    },
  ]
}

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
  const columnVisibility = useMemo(
    () => ({ ...HIDDEN_AT_FIRST, ...prefs.columnVisibility }),
    [prefs.columnVisibility],
  )
  const { view: activeId } = Route.useSearch()
  // "Run on this view" in an AI attribute's column header.
  const columnRun = useColumnRun({
    viewId: views.find((v) => v.id === activeId)?.id ?? null,
    registry,
  })
  const vs = useViewState<{ group: string | null; stage: string | null }>({
    views,
    activeId: activeId ?? null,
    listPath: '/deals',
    columnVisibility,
    setColumnVisibility: prefs.setColumnVisibility,
    defaultExtra: { group: 'active', stage: null },
  })
  const { sorting, setSorting } = vs
  const typeOf = useCallback(
    (slug: string) => registry.find((d) => d.slug === slug)?.type,
    [registry],
  )
  // The Stage chip: a group, or one of its stages. Lives in the view's
  // `extra`, so a saved view remembers it.
  const groupFilter = vs.extra.group
  const stageFilter = vs.extra.stage
  const { setExtra } = vs
  const selectView = (id: string | null) =>
    void navigate({ to: '/deals', search: id === null ? {} : { view: id } })
  const [shape, setShape] = useDealsShape()

  const stageDef = registry.find((d) => d.slug === 'stage')
  const stageOptions = useMemo(
    () => stageDef?.options.options ?? [],
    [stageDef],
  )
  const sourceDef = registry.find((d) => d.slug === 'source')
  const sourceLabel = useCallback(
    (raw: unknown) =>
      sourceDef === undefined || raw == null
        ? null
        : optionLabel(sourceDef, raw),
    [sourceDef],
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

  const groupOf = useCallback(
    (stage: string) =>
      stageOptions.find((o) => o.id === stage)?.group ?? 'active',
    [stageOptions],
  )

  // Stage narrowing runs before the table so the chip stays an independent
  // control; free-text filtering is the table's own, as on every other surface.
  const staged = useMemo(() => {
    return deals.rows.filter((d) => {
      if (!matchesConditions(d.values, vs.conditions, typeOf)) return false
      const stage = String(d.values.stage ?? '')
      if (stageFilter) return stage === stageFilter
      if (groupFilter) return groupOf(stage) === groupFilter
      return true
    })
  }, [deals, groupFilter, stageFilter, groupOf, vs.conditions, typeOf])

  // Counts per group and per stage for the chip — over every deal, which is
  // why this surface holds them all (see the note on the route).
  const { groupCounts, stageCounts } = useMemo(() => {
    const groups = new Map<string, number>()
    const stages = new Map<string, number>()
    for (const d of deals.rows) {
      const stage = String(d.values.stage ?? '')
      const g = groupOf(stage)
      groups.set(g, (groups.get(g) ?? 0) + 1)
      stages.set(stage, (stages.get(stage) ?? 0) + 1)
    }
    return { groupCounts: groups, stageCounts: stages }
  }, [deals, groupOf])

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
    const attribute = (def: RegistryEntry): ColumnDef<DealRow, unknown> =>
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
      )
    const lead = LEAD_COLUMNS.flatMap((slug) =>
      registry.filter((d) => d.slug === slug),
    )
    const rest = registry.filter((d) => !LEAD_COLUMNS.includes(d.slug))
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
      ...lead.map(attribute),
      // Read-only, from the interaction stats.
      ...statColumns<DealRow>().filter((c) => c.id === 'stat:last_contact'),
      ...rest.map(attribute),
    ]
    return defs
  }, [registry, refNames, saveCell])

  const table = useReactTable({
    data: staged,
    columns,
    // What Columns › Reset goes back to.
    initialState: { columnVisibility: HIDDEN_AT_FIRST },
    state: {
      sorting,
      columnVisibility,
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
  const shown = table.getRowModel().rows.map((r) => r.original)

  const refresh = useCallback(() => void router.invalidate(), [router])
  // The selection bar and the row `···`; enrichment reads no deal.
  const actions = useListActions({
    label: 'Deals',
    noun: { one: 'deal', many: 'deals' },
    rows: shown,
    hrefOf: (r) => `/deals/${r.id}`,
    enrich: null,
    refresh,
  })
  // Import… is the head's only rare verb, so the `···` is that verb as the
  // outline secondary, left of the primary.
  const importVerb = useImportVerb('deals')
  const listMenu = <ListMenu label="Deals" verbs={[importVerb]} />

  // The board draws the columns the chip leaves: a group's stages, or one.
  const boardStages: Array<BoardStage> =
    stageFilter !== null
      ? stageOptions.filter((o) => o.id === stageFilter)
      : groupFilter !== null
        ? stageOptions.filter((o) => (o.group ?? 'active') === groupFilter)
        : stageOptions
  // First run: no deal at all — one row that creates, and the head's verb.
  const firstRun = deals.rows.length === 0
  const asTable = shape === 'table'

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Deals"
        action={
          firstRun ? (
            listMenu
          ) : (
            <>
              {listMenu}
              <CreateDealDialog registry={registry} hotkey="c" />
            </>
          )
        }
      />
      {firstRun ? (
        <div className="px-8 pt-6 pb-8">
          <CreateDealDialog
            registry={registry}
            hotkey="c"
            trigger={<EmptyRow name="Deals" />}
          />
        </div>
      ) : (
        <>
          {asTable && actions.selectionBar ? (
            <div className={PIN_UNDER_HEAD_BAR}>{actions.selectionBar}</div>
          ) : (
            <ViewBar
              objectId={objectId}
              registry={registry}
              views={views}
              counts={viewCounts}
              total={deals.rows.length}
              activeId={activeId ?? null}
              snapshot={vs.snapshot}
              plural="Deals"
              onApply={(v) => {
                vs.apply(v)
                selectView(v?.id ?? null)
              }}
              selectView={selectView}
              onFilterChange={vs.setConditions}
              onSaved={() => router.invalidate()}
              canEdit={(v) => v.createdBy === me?.id || me?.role === 'admin'}
              pinned
              refNames={refNames}
              lead={
                <StageChip
                  stages={stageOptions}
                  groupCounts={groupCounts}
                  stageCounts={stageCounts}
                  total={deals.rows.length}
                  group={groupFilter}
                  stage={stageFilter}
                  onPick={(next) => setExtra((e) => ({ ...e, ...next }))}
                />
              }
              tools={
                <TableTools
                  table={table}
                  filter={globalFilter}
                  onFilterChange={setGlobalFilter}
                  filterPlaceholder="Search deals"
                  filterLabel="Search deals"
                  beforeSearch={
                    <Segmented
                      label="Show deals as"
                      value={shape}
                      onChange={setShape}
                      options={[
                        { id: 'table', label: 'Table' },
                        { id: 'board', label: 'Board' },
                      ]}
                      className="ml-1"
                    />
                  }
                />
              }
            />
          )}
          <div className={cn('px-8 pb-8', !asTable && 'pt-4')}>
            {asTable ? (
              <AiCellsProvider
                entityIds={shown.map((r) => r.id)}
                registry={registry}
              >
                <RecordTable
                  columnActions={columnRun.columnActions}
                  table={table}
                  label="Deals"
                  stickyColumnId="name"
                  select={actions.select}
                  rowEnd={actions.rowMenu}
                  pinUnder={
                    actions.selectionBar ? 'bar' : viewBarPin(vs.conditions)
                  }
                  addColumn={
                    <AttributeCreateDialog
                      objectKind="deal"
                      onCreated={() => router.invalidate()}
                      trigger={<AddColumnButton />}
                    />
                  }
                />
              </AiCellsProvider>
            ) : (
              <DealBoard
                deals={shown}
                stages={boardStages}
                valueCurrency={
                  registry.find((d) => d.slug === 'value')?.options.code ??
                  'USD'
                }
                pictures={deals.pictures}
                medianDaysInStage={funnel.medianDaysInStage}
                daysInStage={Object.fromEntries(
                  funnel.daysInStage.map((d) => [d.id, d.days]),
                )}
                sourceLabel={sourceLabel}
              />
            )}
          </div>
          {columnRun.dialog}
        </>
      )}
      {actions.dialogs}
    </div>
  )
}

/** What the Stage chip narrows to: a group, one of its stages, or neither. */
type StagePick = { group: string | null; stage: string | null }

/**
 * The Stage chip in the bar: `Stage Active 9 ▾`, boxed while it narrows.
 * Its popover lists every group and under it its stages, each with its
 * count; a group shows all its stages, a stage shows that one alone. A
 * retired stage stays listed while deals sit on it — that is how they are
 * found and retagged.
 */
function StageChip({
  stages,
  groupCounts,
  stageCounts,
  total,
  group,
  stage,
  onPick,
}: {
  stages: ReadonlyArray<BoardStage>
  groupCounts: ReadonlyMap<string, number>
  stageCounts: ReadonlyMap<string, number>
  total: number
  group: string | null
  stage: string | null
  onPick: (pick: StagePick) => void
}) {
  const [open, setOpen] = useState(false)
  const picked = stages.find((s) => s.id === stage)
  const pickedGroup = STAGE_GROUPS.find((g) => g.id === group)
  const label = picked?.label ?? pickedGroup?.label ?? null
  const count =
    picked !== undefined
      ? (stageCounts.get(picked.id) ?? 0)
      : (groupCounts.get(group ?? '') ?? 0)
  const row = (
    key: string,
    text: string,
    n: number,
    on: boolean,
    next: StagePick,
    inset: boolean,
  ) => (
    <li key={key}>
      <button
        type="button"
        aria-pressed={on}
        onClick={() => {
          onPick(next)
          setOpen(false)
        }}
        className={cn(
          'focus-ring-inset flex h-7 w-full items-center gap-2 px-2.5 text-left text-ui transition-colors duration-150 ease-out-quart',
          inset && 'pl-5',
          on ? 'bg-selected' : 'hover:bg-bone',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <span className="tabular mono text-micro text-graphite">{n}</span>
      </button>
    </li>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolButton active={label !== null} data-stage-chip>
          <span className="text-graphite">Stage</span>
          {label === null ? null : (
            <>
              <span>{label}</span>
              <span className="tabular mono text-micro">{count}</span>
            </>
          )}
          <span aria-hidden className="text-graphite">
            ▾
          </span>
        </ToolButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-80 w-56 overflow-y-auto p-0">
        <ul aria-label="Stages" className="flex flex-col py-1">
          {row(
            'all',
            'All stages',
            total,
            group === null && stage === null,
            { group: null, stage: null },
            false,
          )}
          {STAGE_GROUPS.flatMap((g) => [
            row(
              g.id,
              g.label,
              groupCounts.get(g.id) ?? 0,
              group === g.id && stage === null,
              { group: g.id, stage: null },
              false,
            ),
            ...stages
              .filter((s) => (s.group ?? 'active') === g.id)
              .filter((s) => !s.archived || (stageCounts.get(s.id) ?? 0) > 0)
              .map((s) =>
                row(
                  s.id,
                  s.archived ? `${s.label} · archived` : s.label,
                  stageCounts.get(s.id) ?? 0,
                  stage === s.id,
                  { group: g.id, stage: s.id },
                  true,
                ),
              ),
          ])}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
