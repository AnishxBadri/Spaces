import { createFileRoute } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { Briefcase } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState } from '#/components/empty-state'
import { IconBadge, RecordLinkCell } from '#/components/table/cells'
import { RecordTable, TableToolbar } from '#/components/table/record-table'
import { PageHeader } from '#/components/page-header'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { listHoldings } from '#/lib/server-fns'
import {
  fmtDate,
  fmtMoney,
  fmtMultiple,
  fmtPct,
  fmtXirr,
} from '#/lib/portfolio/format'

export const Route = createFileRoute('/_app/portfolio')({
  loader: async () => listHoldings(),
  component: PortfolioPage,
})

type HoldingRow = Awaited<ReturnType<typeof listHoldings>>['holdings'][number]

const col = createColumnHelper<HoldingRow>()
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

function PortfolioPage() {
  const data = Route.useLoaderData()
  const [globalFilter, setGlobalFilter] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const prefs = useTablePrefs(PREFS_KEY)

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
        cell: (info) => {
          const m = metricsOf(info.row.original)
          return (
            <span className="tabular">
              {m
                ? fmtMoney(m.costBasis, m.currency, { compact: true })
                : 'needs fx rate'}
            </span>
          )
        },
      }),
      col.accessor((r) => metricsOf(r)?.unrealized ?? 0, {
        id: 'value',
        header: 'Current value',
        size: 140,
        cell: (info) => {
          const m = metricsOf(info.row.original)
          if (!m) return <span className="text-muted-foreground">—</span>
          return (
            <span className="tabular">
              {fmtMoney(m.unrealized, m.currency, { compact: true })}
            </span>
          )
        },
      }),
      col.accessor((r) => metricsOf(r)?.realized ?? 0, {
        id: 'realized',
        header: 'Realized',
        size: 120,
        cell: (info) => {
          const m = metricsOf(info.row.original)
          if (!m) return <span className="text-muted-foreground">—</span>
          return (
            <span className="tabular">
              {m.realized > 0
                ? fmtMoney(m.realized, m.currency, { compact: true })
                : '—'}
            </span>
          )
        },
      }),
      col.accessor((r) => ownershipText(r), {
        id: 'ownership',
        header: 'Ownership',
        size: 110,
        cell: (info) => (
          <span className="tabular">{ownershipText(info.row.original)}</span>
        ),
      }),
      col.accessor((r) => metricsOf(r)?.moic ?? -1, {
        id: 'moic',
        header: 'MOIC',
        size: 90,
        cell: (info) => (
          <span className="tabular">
            {fmtMultiple(metricsOf(info.row.original)?.moic ?? null)}
          </span>
        ),
      }),
      col.accessor((r) => metricsOf(r)?.grossXirr ?? -999, {
        id: 'xirr',
        header: 'Gross XIRR',
        size: 100,
        cell: (info) => (
          <span className="tabular">
            {fmtXirr(metricsOf(info.row.original)?.grossXirr ?? null)}
          </span>
        ),
      }),
      col.accessor((r) => metricsOf(r)?.lastMarkDate ?? '', {
        id: 'lastMark',
        header: 'Last mark',
        size: 110,
        sortUndefined: 'last',
        cell: (info) => {
          const m = metricsOf(info.row.original)
          const d = m?.lastMarkDate ?? null
          return (
            <span className={d ? 'tabular' : 'text-muted-foreground'}>
              {m?.writtenOff ? 'written off' : fmtDate(d)}
            </span>
          )
        },
      }),
    ]
    return defs
  }, [])

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

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Portfolio"
        description="Every holding computed live from its event ledger — checks, marks, distributions. Staleness is visible on purpose."
      />
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        {data.holdings.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No holdings yet"
            body="A holding is born when a deal reaches Invested — or record a check directly from a company page. Existing positions arrive via the bootstrap import."
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-baseline gap-x-8 gap-y-2">
              <RollupStat
                label="Invested"
                value={fmtMoney(rollup.costBasis, data.baseCurrency, {
                  compact: true,
                })}
              />
              <RollupStat
                label="Current value"
                value={fmtMoney(rollup.unrealized, data.baseCurrency, {
                  compact: true,
                })}
              />
              <RollupStat
                label="Realized"
                value={fmtMoney(rollup.realized, data.baseCurrency, {
                  compact: true,
                })}
              />
              <RollupStat label="MOIC" value={fmtMultiple(rollup.moic)} />
              {rollup.excludedForMissingRates.length > 0 ? (
                <span className="text-ui text-destructive">
                  {rollup.excludedForMissingRates.length} holding
                  {rollup.excludedForMissingRates.length === 1 ? '' : 's'}{' '}
                  excluded from totals — fx rates missing (Settings → FX rates)
                </span>
              ) : null}
            </div>
            <TableToolbar
              table={table}
              filter={globalFilter}
              onFilterChange={setGlobalFilter}
              filterPlaceholder="Filter by company…"
              filterLabel="Filter holdings"
              noun={{ one: 'holding', many: 'holdings' }}
              total={data.holdings.length}
              shown={table.getRowModel().rows.length}
            />
            <RecordTable
              table={table}
              label="Portfolio"
              stickyColumnId="company"
            />
          </>
        )}
      </div>
    </div>
  )
}

function RollupStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-label text-muted-foreground">{label}</span>
      <span className="tabular text-ui font-medium">{value}</span>
    </div>
  )
}
