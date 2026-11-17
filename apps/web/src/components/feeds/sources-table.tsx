import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { formatWhen } from '@spaces/core/format'
import { urlAtRest } from '#/components/attributes/value-editor'
import { useClock } from '#/components/clock'
import { icon } from '#/components/icons'
import { RecordTable } from '#/components/table/record-table'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { Twinkle } from '#/components/twinkle'
import { MoreMenu } from '#/components/ui/more-menu'
import type { FeedSource } from '#/lib/server-fns'
import { FeedLogo } from './feed-logo'
import { failingLine, spacesLine } from './feed-words'

/**
 * The Sources tab: every feed as a row of the fixed pane's table — Name
 * (logo and name), Feed, Spaces by path, Latest. A failing feed's Latest is
 * the square, since when, and `Fix ›`; a feed waiting on its first fetch
 * twinkles there until the fetch lands. The row opens the feed's window.
 */

const col = createColumnHelper<FeedSource>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'spaces.feed-sources-table.v1'
// The four columns and the trailing lane fit a 1280px window's card, so
// `Fix ›` is never under the overflow fade.

export function SourcesTable({
  sources,
  pathOf,
  notice,
  onEdit,
  onFix,
  onRemove,
}: {
  sources: ReadonlyArray<FeedSource>
  /** A space's path (`Aerospace › Launch`) by its id. */
  pathOf: ReadonlyMap<string, string>
  /** Drawn in place of the rows: the list loading or failed. */
  notice?: ReactNode
  onEdit: (source: FeedSource) => void
  onFix: (source: FeedSource) => void
  onRemove: (source: FeedSource) => void
}) {
  const { now, today } = useClock()
  const prefs = useTablePrefs(PREFS_KEY)
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'name', desc: false },
  ])

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<FeedSource, unknown>> = [
      col.accessor((r) => r.name.toLowerCase(), {
        id: 'name',
        header: 'Name',
        size: 220,
        enableHiding: false,
        cell: (info) => {
          const r = info.row.original
          return (
            <button
              type="button"
              // The row click opens the same window; one intent, one call.
              onClick={(e) => {
                e.stopPropagation()
                onEdit(r)
              }}
              title={`Edit ${r.name}`}
              className="focus-ring-inset flex h-full min-w-0 items-center gap-2 px-1 text-left"
            >
              <FeedLogo name={r.name} logoUrl={r.logoUrl} />
              <span className="truncate">{r.name}</span>
            </button>
          )
        },
      }),
      col.accessor((r) => urlAtRest(r.url), {
        id: 'feed',
        header: 'Feed',
        size: 280,
        cell: (info) => (
          <span
            title={info.row.original.url}
            className="block truncate px-1 mono text-label"
          >
            {String(info.getValue())}
          </span>
        ),
      }),
      col.accessor((r) => spacesLine(r.spaces, pathOf), {
        id: 'spaces',
        header: 'Spaces',
        size: 220,
        cell: (info) => {
          const line = String(info.getValue())
          return line === '' ? (
            <span className="px-1 text-graphite">—</span>
          ) : (
            <span title={line} className="block truncate px-1">
              {line}
            </span>
          )
        },
      }),
      // Up, the failing feeds come first: what needs a hand; then by the
      // newest story's time, a feed with none last.
      col.accessor((r) => (r.state === 'failing' ? '' : (r.newestAt ?? '~')), {
        id: 'latest',
        header: 'Latest',
        size: 240,
        cell: (info) => (
          <LatestCell
            source={info.row.original}
            now={now}
            today={today}
            onFix={onFix}
          />
        ),
      }),
    ]
    return defs
  }, [now, today, pathOf, onEdit, onFix])

  const table = useReactTable({
    data: useMemo(() => [...sources], [sources]),
    columns,
    state: {
      sorting,
      columnVisibility: prefs.columnVisibility,
      columnSizing: prefs.columnSizing,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: prefs.setColumnVisibility,
    onColumnSizingChange: prefs.setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: 'onChange',
  })

  return (
    <RecordTable
      joined
      folder
      table={table}
      label="Sources"
      stickyColumnId="name"
      notice={notice}
      onRowClick={onEdit}
      rowEnd={(r) => (
        <MoreMenu
          variant="row"
          label={r.name}
          forceMenu
          items={[
            {
              label: 'Edit…',
              icon: <icon.edit />,
              opens: true,
              onSelect: () => onEdit(r),
            },
            {
              label: 'Copy feed URL',
              icon: <icon.copyLink />,
              copy: () => r.url,
            },
            {
              label: 'Remove…',
              icon: <icon.delete />,
              opens: true,
              destructive: true,
              onSelect: () => onRemove(r),
            },
          ]}
        />
      )}
    />
  )
}

/**
 * Latest: the newest headline's time today, else its day; a failing feed's
 * square and since-when with `Fix ›`; the first fetch still out, the
 * Twinkle. A feed that fetched and holds nothing prints a dash.
 */
function LatestCell({
  source,
  now,
  today,
  onFix,
}: {
  source: FeedSource
  now: string
  today: string
  onFix: (source: FeedSource) => void
}) {
  if (source.state === 'failing')
    return (
      <span
        data-latest="failing"
        className="flex min-w-0 items-center gap-2 px-1"
      >
        <span aria-hidden className="size-1.5 shrink-0 bg-destructive" />
        <span
          {...(source.lastError === null ? {} : { title: source.lastError })}
          className="min-w-0 flex-1 truncate"
        >
          {failingLine(source, today)}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onFix(source)
          }}
          className="focus-ring shrink-0 rounded-md font-medium hover:underline"
        >
          Fix ›
        </button>
      </span>
    )
  if (source.state === 'new')
    return (
      <span
        data-latest="new"
        className="flex items-center gap-2 px-1 text-label text-graphite"
      >
        <Twinkle />
        Fetching
      </span>
    )
  if (source.newestAt === null)
    return <span className="px-1 text-graphite">—</span>
  return (
    <time
      data-latest="ok"
      dateTime={source.newestAt}
      className="block px-1 mono text-label"
    >
      {formatWhen(source.newestAt, now)}
    </time>
  )
}
