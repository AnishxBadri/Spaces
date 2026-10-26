import { Link, createFileRoute } from '@tanstack/react-router'
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
import { HeadCount, PageHeader } from '#/components/page-header'
import { PortfolioHeadlineStrip } from '#/components/portfolio-headline'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { listHoldings } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
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
          // The mark's own ISO day, as every date in a list prints.
          return (
            <Figure muted>
              {m?.writtenOff ? 'written off' : (m?.lastMarkDate ?? '—')}
            </Figure>
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
  const excluded = rollup.excludedForMissingRates.length

  return (
    <div className="flex flex-col">
      <PageHeader
        title={<HeadCount title="Portfolio" count={data.holdings.length} />}
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
      />
      {data.holdings.length === 0 ? (
        <div className="px-8 pb-8">
          <EmptyState
            icon={Briefcase}
            title="No holdings yet"
            body="A holding is born when a deal reaches Invested — or record a check directly from a company page. Existing positions arrive via the bootstrap import."
          />
        </div>
      ) : (
        <>
          <PortfolioHeadlineStrip
            rollup={rollup}
            baseCurrency={data.baseCurrency}
          />
          <TableToolbar
            table={table}
            label="Holdings"
            tabs={[{ id: 'all', label: 'All', count: data.holdings.length }]}
            value="all"
            onValueChange={() => {}}
            filter={globalFilter}
            onFilterChange={setGlobalFilter}
            filterPlaceholder="Filter by company…"
            filterLabel="Filter holdings"
          />
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
