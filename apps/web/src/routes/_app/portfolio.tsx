import { Link, createFileRoute } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState, Table } from '@tanstack/react-table'
import { Briefcase } from 'lucide-react'
import { useMemo, useState } from 'react'
import { RecordCheckDialog } from '#/components/holding/record-check-dialog'
import { EmptyRow } from '#/components/ledger-section'
import { IconBadge, RecordLinkCell } from '#/components/table/cells'
import { RecordTable } from '#/components/table/record-table'
import { HeadCount, PageHeader } from '#/components/page-header'
import { PortfolioHeadlineStrip } from '#/components/portfolio-headline'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { MENU_RULE, MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { useClock } from '#/components/clock'
import { listHoldings } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { formatDay } from '@spaces/core/format'
import {
  fmtMoney,
  fmtMultiple,
  fmtPct,
  fmtXirr,
} from '@spaces/core/portfolio/format'

/**
 * **This page does not page, deliberately.** Every number above the table —
 * cost basis, unrealized, realized, TVPI — is summed across **all** holdings,
 * and the excluded-rows banner counts out of the same whole; a paged loader
 * would compute a fund's position from whichever rows arrived first. If this
 * outgrows one fetch, the totals become their own server aggregate before the
 * rows become a page — never the other way round.
 *
 * One view and no tab bar: the title carries the count, and Search, Sort and
 * Columns are rare enough to live in the head's `···`.
 */
export const Route = createFileRoute('/_app/portfolio')({
  loader: async () => listHoldings(),
  component: PortfolioPage,
})

type HoldingRow = Awaited<ReturnType<typeof listHoldings>>['holdings'][number]

const col = createColumnHelper<HoldingRow>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'dealos.portfolio-table.v1'

function metricsOf(r: HoldingRow) {
  return r.metrics.ok ? r.metrics.metrics : null
}

function ownershipText(r: HoldingRow): string {
  const o = r.ownership
  if (o.kind === 'actual') return fmtPct(o.currentPct)
  if (o.kind === 'implied') return `~${fmtPct(o.pct)}`
  return '—'
}

/** The column's own label, for a menu that names it. */
const titleOf = (c: { id: string; columnDef: { header?: unknown } }) =>
  typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id

/**
 * The head `···`: Search… first, then Sort and Columns as submenus — the
 * same single sort and the same show and hide the bar's tools give a list.
 */
function headMenu(
  table: Table<HoldingRow>,
  onSearch: () => void,
): Array<MoreMenuEntry> {
  const current = table.getState().sorting.at(0)
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide())
  return [
    { label: 'Search…', opens: true, onSelect: onSearch },
    MENU_RULE,
    {
      label: 'Sort',
      items: [
        ...table
          .getVisibleLeafColumns()
          .filter((c) => c.getCanSort())
          .map((c) => {
            const on = c.id === current?.id
            const desc = current?.desc === true
            return {
              label: titleOf(c),
              ...(on ? { hint: desc ? '↓' : '↑' } : {}),
              // A second pick of the sorted column turns it round.
              onSelect: () => c.toggleSorting(on && !desc),
            }
          }),
        ...(current === undefined
          ? []
          : [
              { label: 'Clear sort', onSelect: () => table.resetSorting(true) },
            ]),
      ],
    },
    {
      label: 'Columns',
      items: hideable.map((c) => ({
        label: titleOf(c),
        checked: c.getIsVisible(),
        onCheckedChange: (v: boolean) => c.toggleVisibility(v),
      })),
    },
  ]
}

function PortfolioPage() {
  const data = Route.useLoaderData()
  const [globalFilter, setGlobalFilter] = useState('')
  const [searching, setSearching] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const prefs = useTablePrefs(PREFS_KEY)
  const { today } = useClock()

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<HoldingRow, unknown>> = [
      col.accessor((r) => r.companyName, {
        id: 'company',
        header: 'Company',
        size: 240,
        enableHiding: false,
        cell: (info) => (
          <RecordLinkCell
            to="/portfolio/$holdingId"
            params={{ holdingId: info.row.original.id }}
            name={info.row.original.companyName}
            badge={<IconBadge icon={Briefcase} />}
          />
        ),
      }),
      col.accessor((r) => metricsOf(r)?.costBasis ?? 0, {
        id: 'invested',
        header: 'Invested',
        size: 130,
        meta: { numeric: true },
        cell: (info) => {
          const m = metricsOf(info.row.original)
          return m ? (
            <Figure>
              {fmtMoney(m.costBasis, m.currency, { compact: true })}
            </Figure>
          ) : (
            <span className="block px-1 text-right mono text-label text-graphite">
              needs fx rate
            </span>
          )
        },
      }),
      col.accessor((r) => metricsOf(r)?.unrealized ?? 0, {
        id: 'value',
        header: 'Current value',
        size: 140,
        meta: { numeric: true },
        cell: (info) => {
          const m = metricsOf(info.row.original)
          if (!m) return <Figure muted>—</Figure>
          return (
            <Figure>
              {fmtMoney(m.unrealized, m.currency, { compact: true })}
            </Figure>
          )
        },
      }),
      col.accessor((r) => metricsOf(r)?.realized ?? 0, {
        id: 'realized',
        header: 'Realized',
        size: 120,
        meta: { numeric: true },
        cell: (info) => {
          const m = metricsOf(info.row.original)
          if (!m || m.realized <= 0) return <Figure muted>—</Figure>
          return (
            <Figure>
              {fmtMoney(m.realized, m.currency, { compact: true })}
            </Figure>
          )
        },
      }),
      col.accessor((r) => ownershipText(r), {
        id: 'ownership',
        header: 'Ownership',
        size: 110,
        meta: { numeric: true },
        cell: (info) => <Figure>{ownershipText(info.row.original)}</Figure>,
      }),
      col.accessor((r) => metricsOf(r)?.moic ?? -1, {
        id: 'moic',
        header: 'MOIC',
        size: 90,
        meta: { numeric: true },
        cell: (info) => (
          <Figure>
            {fmtMultiple(metricsOf(info.row.original)?.moic ?? null)}
          </Figure>
        ),
      }),
      col.accessor((r) => metricsOf(r)?.grossXirr ?? -999, {
        id: 'xirr',
        header: 'Gross XIRR',
        size: 110,
        meta: { numeric: true },
        cell: (info) => (
          <Figure>
            {fmtXirr(metricsOf(info.row.original)?.grossXirr ?? null)}
          </Figure>
        ),
      }),
      col.accessor((r) => metricsOf(r)?.lastMarkDate ?? '', {
        id: 'lastMark',
        header: 'Last mark',
        size: 110,
        sortUndefined: 'last',
        meta: { numeric: true },
        cell: (info) => {
          const m = metricsOf(info.row.original)
          return (
            <Figure muted>
              {m?.writtenOff
                ? 'written off'
                : m?.lastMarkDate
                  ? formatDay(m.lastMarkDate, today)
                  : '—'}
            </Figure>
          )
        },
      }),
    ]
    return defs
  }, [today])

  const table = useReactTable({
    data: data.holdings,
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
    globalFilterFn: (row, _colId, filter) =>
      row.original.companyName
        .toLowerCase()
        .includes(String(filter).toLowerCase()),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange',
  })

  const rollup = data.rollup
  const excluded = rollup.excludedForMissingRates.length
  const firstRun = data.holdings.length === 0
  const showSearch = searching || globalFilter !== ''

  return (
    <div className="flex flex-col">
      <PageHeader
        title={
          <HeadCount
            title="Portfolio"
            count={firstRun ? null : data.holdings.length}
          />
        }
        description={
          excluded > 0 ? (
            <span>
              {excluded} holding{excluded === 1 ? '' : 's'} out of the totals ·
              fx rate missing ·{' '}
              <Link
                to="/settings/currency"
                className="focus-ring text-foreground underline-offset-4 hover:underline"
              >
                set rates ›
              </Link>
            </span>
          ) : undefined
        }
        action={
          firstRun ? undefined : (
            <>
              <RecordCheckDialog
                trigger={<Button variant="outline">Record a check</Button>}
              />
              <MoreMenu
                variant="head"
                label="Portfolio"
                items={headMenu(table, () => setSearching(true))}
              />
            </>
          )
        }
      />
      {firstRun ? (
        <div className="px-8 pt-6 pb-8">
          <RecordCheckDialog trigger={<EmptyRow name="Holdings" />} />
        </div>
      ) : (
        <>
          <PortfolioHeadlineStrip
            rollup={rollup}
            baseCurrency={data.baseCurrency}
          />
          {showSearch ? (
            <div className="flex h-11 items-center border-b border-rule bg-bone px-8">
              <Input
                autoFocus
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.preventDefault()
                  setGlobalFilter('')
                  setSearching(false)
                }}
                onBlur={() => {
                  if (globalFilter === '') setSearching(false)
                }}
                placeholder="Search holdings"
                aria-label="Search holdings"
                className="h-6.5 w-45 bg-paper text-ui"
              />
            </div>
          ) : null}
          <div className="px-8 pb-8">
            <RecordTable
              table={table}
              label="Portfolio"
              stickyColumnId="company"
            />
          </div>
        </>
      )}
    </div>
  )
}

/** A figure in a column: mono, tabular, right-aligned under its head. */
function Figure({ muted, children }: { muted?: boolean; children: string }) {
  return (
    <span
      className={cn(
        'block truncate px-1 numeric mono',
        muted ? 'text-graphite' : 'text-foreground',
      )}
    >
      {children}
    </span>
  )
}
