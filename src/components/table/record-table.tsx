import { flexRender } from '@tanstack/react-table'
import type { Header, Table } from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Columns3,
  Plus,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'

/**
 * The one record table. Companies, People and Deals are the same object shaped
 * three ways — registry-generated columns over `entity.values` — so they render
 * through one component. Three near-identical implementations is what let the
 * type scale, the focus ring and the sort affordance drift apart in the first
 * place; the fix is that there is now only one place to change.
 *
 * In scope (CONTEXT.md's v1 line): show/hide/resize, single sort, sticky header,
 * sticky first column, row → record. Deliberately absent: saved views, bulk
 * edit, calculations row, CSV, virtualization.
 */

/** Column widths nudge by this much per arrow-key press. */
const RESIZE_STEP = 16
const MIN_COLUMN_WIDTH = 64

export function RecordTable<T>({
  table,
  stickyColumnId,
  addColumn,
  label,
}: {
  table: Table<T>
  /** Column pinned to the left edge while the rest scrolls under it. */
  stickyColumnId?: string
  /** The "+ Add column" control, rendered in the trailing header cell. */
  addColumn?: ReactNode
  /** Accessible name for the grid, e.g. "Companies". */
  label: string
}) {
  const rows = table.getRowModel().rows

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border">
      <table
        aria-label={label}
        className="w-full border-collapse text-ui"
        style={{ width: table.getTotalSize() }}
      >
        <thead className="sticky top-0 z-10 bg-background">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-border">
              {hg.headers.map((header) => (
                <HeaderCell
                  key={header.id}
                  header={header}
                  table={table}
                  sticky={header.column.id === stickyColumnId}
                />
              ))}
              {addColumn ? (
                <th className="w-10 px-1">{addColumn}</th>
              ) : (
                <th className="w-10" />
              )}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="group h-row border-b border-border/60 transition-colors duration-150 ease-out-quart last:border-b-0 hover:bg-row-hover"
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  style={{ width: cell.column.getSize() }}
                  className={cn(
                    'border-r border-border/40 px-1 align-middle last:border-r-0',
                    cell.column.id === stickyColumnId &&
                      // Opaque at rest and on hover: a translucent tint here
                      // would let the scrolled-under columns bleed through.
                      'sticky left-0 z-10 bg-background transition-colors duration-150 ease-out-quart group-hover:bg-row-hover',
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
              <td className="w-10" />
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length === 0 ? (
        // Pinned to the left of the scroll viewport: centring it on the table's
        // full width would park the message off-screen once the grid is wider
        // than the pane and the user has scrolled.
        <p className="sticky left-0 w-full px-3 py-6 text-center text-ui text-muted-foreground">
          Nothing matches that filter.
        </p>
      ) : null}
    </div>
  )
}

function HeaderCell<T>({
  header,
  table,
  sticky,
}: {
  header: Header<T, unknown>
  table: Table<T>
  sticky: boolean
}) {
  const { column } = header
  const sorted = column.getIsSorted()
  const title =
    typeof column.columnDef.header === 'string'
      ? column.columnDef.header
      : column.id

  /** Column resize by keyboard — the drag handle alone is mouse-only. */
  function nudge(delta: number) {
    table.setColumnSizing((old) => ({
      ...old,
      [column.id]: Math.max(MIN_COLUMN_WIDTH, column.getSize() + delta),
    }))
  }

  return (
    <th
      style={{ width: header.getSize() }}
      aria-sort={
        sorted === 'asc'
          ? 'ascending'
          : sorted === 'desc'
            ? 'descending'
            : 'none'
      }
      className={cn(
        'relative h-row border-r border-border/60 px-2 text-left align-middle font-medium text-muted-foreground last:border-r-0',
        sticky && 'sticky left-0 z-20 bg-background',
      )}
    >
      {column.getCanSort() ? (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          title={`Sort by ${title}`}
          className="focus-ring group/sort flex w-full items-center gap-1 truncate rounded text-left transition-colors duration-150 ease-out-quart hover:text-foreground"
        >
          <span className="truncate">
            {flexRender(column.columnDef.header, header.getContext())}
          </span>
          {sorted === 'asc' ? (
            <ArrowUp className="size-3 shrink-0 text-primary" strokeWidth={2} />
          ) : sorted === 'desc' ? (
            <ArrowDown
              className="size-3 shrink-0 text-primary"
              strokeWidth={2}
            />
          ) : (
            // The affordance only appears when the header is reachable, so an
            // unsorted table stays quiet but never hides that it can sort.
            <ChevronsUpDown
              className="size-3 shrink-0 opacity-0 transition-opacity duration-150 ease-out-quart group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100"
              strokeWidth={2}
              aria-hidden
            />
          )}
        </button>
      ) : (
        <span className="block truncate">
          {flexRender(column.columnDef.header, header.getContext())}
        </span>
      )}

      {column.getCanResize() ? (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${title} column`}
          aria-valuenow={Math.round(column.getSize())}
          tabIndex={0}
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              nudge(-RESIZE_STEP)
            }
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              nudge(RESIZE_STEP)
            }
          }}
          className="focus-ring-inset absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none select-none transition-colors duration-150 ease-out-quart hover:bg-primary"
        />
      ) : null}
    </th>
  )
}

/**
 * Filter · column visibility · result count on one line, in that order, so the
 * filter is always top-left of the reader's eye and the count always far right.
 * Surface-specific controls (the deals stage chips) get their own band below:
 * inlining them pushed the column menu and the count onto a second line and
 * left both orphaned, which is worse than one extra row.
 */
export function TableToolbar<T>({
  table,
  filter,
  onFilterChange,
  filterPlaceholder,
  filterLabel,
  noun,
  total,
  shown,
  children,
}: {
  table: Table<T>
  filter: string
  onFilterChange: (value: string) => void
  filterPlaceholder: string
  filterLabel: string
  /** What the count counts, both forms — "1 deal" / "12 deals". */
  noun: { one: string; many: string }
  /** Rows before filtering. */
  total: number
  /** Rows after filtering. */
  shown: number
  /** Surface-specific controls (e.g. the deals stage chips). */
  children?: ReactNode
}) {
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide())
  const hiddenCount = hideable.filter((c) => !c.getIsVisible()).length

  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={filterPlaceholder}
          aria-label={filterLabel}
          className="h-8 max-w-xs text-ui"
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="text-ui">
              <Columns3 className="size-3.5" strokeWidth={1.75} />
              Columns
              {hiddenCount > 0 ? (
                <span className="tabular text-muted-foreground">
                  {hideable.length - hiddenCount}/{hideable.length}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel className="text-label text-muted-foreground">
              Show columns
            </DropdownMenuLabel>
            {hideable.map((c) => (
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

        {/* A bare "3" reads as an unlabelled artefact; the count says what it
            counts, and only says "of N" once a filter is actually hiding rows. */}
        <output className="ml-auto whitespace-nowrap text-label text-muted-foreground">
          <span className="tabular">{shown}</span>
          {shown === total ? null : (
            <>
              {' of '}
              <span className="tabular">{total}</span>
            </>
          )}
          {` ${total === 1 ? noun.one : noun.many}`}
        </output>
      </div>

      {children ? (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  )
}

/**
 * The trailing header control that creates an attribute inline. Pass it to
 * `AttributeCreateDialog`'s `trigger` — the dialog owns the flow, this is only
 * the affordance, and it must look the same on every table.
 */
export function AddColumnButton() {
  return (
    <button
      type="button"
      aria-label="Add column"
      title="Add column"
      className="focus-ring flex size-6 items-center justify-center rounded text-muted-foreground transition-colors duration-150 ease-out-quart hover:bg-accent hover:text-foreground"
    >
      <Plus className="size-3.5" strokeWidth={2} />
    </button>
  )
}

/** Page title + one line of what the surface is for + its primary action. */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-page font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-prose text-ui text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </header>
  )
}
