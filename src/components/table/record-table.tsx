import { flexRender } from '@tanstack/react-table'
import type { Header, Table } from '@tanstack/react-table'
import { ChevronsUpDown, Columns3, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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

  // `isolate`: the sticky head and pinned column order themselves with small
  // local z values inside one stacking context, so the page's five-step scale
  // never has to climb (DESIGN.md z-index scale).
  return (
    <div className="isolate mt-3 flex min-h-0 flex-1 flex-col overflow-auto">
      <table
        aria-label={label}
        className="w-full border-collapse text-ui"
        style={{ width: table.getTotalSize() }}
      >
        <thead className="sticky top-0 z-10 bg-paper">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-hairline">
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
              className="group h-row border-b border-rule transition-colors duration-150 ease-out-quart hover:bg-row-hover"
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  style={{ width: cell.column.getSize() }}
                  className={cn(
                    'px-1 align-middle',
                    cell.column.id === stickyColumnId &&
                      // Opaque at rest and on hover: a translucent tint here
                      // would let the scrolled-under columns bleed through.
                      'sticky left-0 z-10 bg-paper transition-colors duration-150 ease-out-quart group-hover:bg-row-hover',
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
              <td className="w-10" />
            </tr>
          ))}
        </tbody>
        {rows.length > 0 ? (
          // The foot: how much of the ledger is on the page, and where it ends.
          <tfoot>
            <tr className="h-8 border-t border-hairline">
              <td
                colSpan={
                  table.getVisibleLeafColumns().length + (addColumn ? 1 : 0)
                }
                className="px-2 align-middle"
              >
                <div className="flex items-center justify-between">
                  <span className="label-caps font-normal text-graphite">
                    {rows.length} of{' '}
                    {table.getPreFilteredRowModel().rows.length}
                  </span>
                  <span className="mono text-micro text-graphite">end</span>
                </div>
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>

      {rows.length === 0 ? (
        // Pinned to the left of the scroll viewport: centring it on the table's
        // full width would park the message off-screen once the grid is wider
        // than the pane and the user has scrolled.
        <p className="sticky left-0 w-full px-3 py-6 text-center text-ui text-graphite">
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
        'relative h-8 px-2 text-left align-middle label-caps text-graphite',
        sticky && 'sticky left-0 z-20 bg-paper',
      )}
    >
      {column.getCanSort() || column.getCanHide() ? (
        // Header cells are buttons: the menu carries sort both ways and hide.
        // The sort direction reads as a mono arrow after the label; the
        // chevron only appears on hover, so a resting header stays quiet.
        <DropdownMenu>
          <DropdownMenuTrigger
            title={`${title} column`}
            className={cn(
              'group/sort focus-ring-inset -mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-1.5 truncate px-2 text-left transition-colors duration-150 ease-out-quart hover:bg-bone data-[state=open]:bg-bone',
              sorted && 'text-foreground',
            )}
          >
            <span className="truncate">
              {flexRender(column.columnDef.header, header.getContext())}
            </span>
            {sorted === 'asc' ? (
              <span className="shrink-0 mono text-micro font-normal tracking-normal">
                ↑
              </span>
            ) : sorted === 'desc' ? (
              <span className="shrink-0 mono text-micro font-normal tracking-normal">
                ↓
              </span>
            ) : null}
            <ChevronsUpDown
              className="ml-auto size-3 shrink-0 opacity-0 transition-opacity duration-150 ease-out-quart group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100 group-data-[state=open]/sort:opacity-100"
              strokeWidth={2}
              aria-hidden
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-50">
            {column.getCanSort() ? (
              <>
                <DropdownMenuItem onSelect={() => column.toggleSorting(false)}>
                  Sort A → Z
                  <span className="ml-auto mono text-micro text-graphite">
                    ↑
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => column.toggleSorting(true)}>
                  Sort Z → A
                  <span className="ml-auto mono text-micro text-graphite">
                    ↓
                  </span>
                </DropdownMenuItem>
                {sorted ? (
                  <DropdownMenuItem onSelect={() => column.clearSorting()}>
                    Clear sort
                  </DropdownMenuItem>
                ) : null}
              </>
            ) : null}
            {column.getCanSort() && column.getCanHide() ? (
              <DropdownMenuSeparator />
            ) : null}
            {column.getCanHide() ? (
              <DropdownMenuItem onSelect={() => column.toggleVisibility(false)}>
                Hide column
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
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
          className="focus-ring-inset absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none transition-colors duration-150 ease-out-quart select-none hover:bg-primary"
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
                <span className="tabular text-graphite">
                  {hideable.length - hiddenCount}/{hideable.length}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-80 w-60 overflow-y-auto p-0"
          >
            <div className="flex h-8 items-center justify-between border-b border-rule px-2.5">
              <DropdownMenuLabel className="p-0 field-label leading-4 text-foreground">
                Columns · {hideable.length - hiddenCount} of {hideable.length}
              </DropdownMenuLabel>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  onClick={() => table.resetColumnVisibility()}
                  className="focus-ring mono text-field text-graphite hover:text-foreground"
                >
                  reset
                </button>
              ) : null}
            </div>
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
        <output className="ml-auto text-label whitespace-nowrap text-graphite">
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
      className="focus-ring flex size-6 items-center justify-center rounded-md text-graphite transition-colors duration-150 ease-out-quart hover:bg-bone hover:text-foreground"
    >
      <Plus className="size-3.5" strokeWidth={2} />
    </button>
  )
}
