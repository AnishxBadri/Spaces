import { flexRender } from '@tanstack/react-table'
import type { Column, Header, RowData, Table } from '@tanstack/react-table'
import { ArrowUpDown, ChevronsUpDown, Columns3, Plus } from 'lucide-react'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { PIN_UNDER_HEAD_BAR } from '#/components/head-fold'
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
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Tabs } from '#/components/ui/tabs'
import type { TabItem } from '#/components/ui/tabs'
import type { RowSelection } from './selection-bar'
import { cn } from '#/lib/utils'

declare module '@tanstack/react-table' {
  // A column of comparable figures: its head right-aligns over `numeric` cells.
  interface ColumnMeta<TData extends RowData, TValue> {
    numeric?: boolean
  }
}

/**
 * The one record table. Companies, People and Deals are the same object shaped
 * three ways — registry-generated columns over `entity.values` — so they render
 * through one component. Three near-identical implementations is what let the
 * type scale, the focus ring and the sort affordance drift apart in the first
 * place; the fix is that there is now only one place to change.
 *
 * In scope (CONTEXT.md's v1 line): show/hide/resize, single sort, sticky header,
 * sticky first column, row → record, and row checkboxes for a selection bar's
 * verbs. Deliberately absent: bulk edit, calculations row, CSV, virtualization.
 *
 * The head is its own table, pinned under the folded page head: the page
 * scrolls vertically, and a horizontal scroller around one table would trap a
 * sticky `thead` inside it. The body scrolls sideways and drives the head's
 * `scrollLeft`; both tables share one set of fixed column widths.
 * - Every cell's content is bounded to the 36px row.
 */

/** Column widths nudge by this much per arrow-key press. */
const RESIZE_STEP = 16
const MIN_COLUMN_WIDTH = 64
/** The checkbox lane's width: `w-8`, which the pinned column's `left-8` clears. */
const SELECT_WIDTH = 32
/** The trailing lane's floor: the add-column control, or the right margin. */
const TRAILING_WIDTH = 40

/**
 * Grouped, never compact — `Intl.NumberFormat` compact notation prints
 * differently under Node and Chrome and takes hydration down with it
 * (CLAUDE.md, traps). The locale is named so the two agree on the separator.
 */
const grouped = (n: number) => n.toLocaleString('en-US')

/**
 * What a paged surface tells its foot (SPA-64). Absent on every unpaged
 * surface, which keeps reading `getPreFilteredRowModel()` — those tables
 * hold every row they could show, so the pre-filtered model *is* the truth
 * there and a server round trip would only be able to agree with it.
 */
export type TablePage = {
  /** The server's `count(*)` over the same `where` the page was cut from. */
  total: number
  /** Another page exists after the ones loaded. */
  hasMore: boolean
  /** A page is in flight. */
  loading: boolean
  /** Rows per page — the number the link offers to add. */
  step: number
  onLoadMore: () => void
}

/**
 * A surface's own verb in a column's header menu, after sort and hide —
 * "Run on this view" on an AI attribute's column (SPA-122). The menu closes
 * on select, so a verb that opens a dialog keeps the dialog outside it and
 * only flips its state here.
 */
export type ColumnAction = {
  label: string
  onSelect: () => void
}

/**
 * Row checkboxes: a pinned lane before the first column, shared with the
 * surface's `SelectionBar` through one `useRowSelection`. The head box checks
 * every loaded row.
 */
export type TableSelect<T> = {
  rows: RowSelection
  keyOf: (row: T) => string
  nameOf: (row: T) => string
}

export function RecordTable<T>({
  table,
  stickyColumnId,
  addColumn,
  label,
  onRowClick,
  page,
  columnActions,
  select,
}: {
  table: Table<T>
  /** Column pinned to the left edge while the rest scrolls under it. */
  stickyColumnId?: string
  /** The "+ Add column" control, rendered in the trailing header cell. */
  addColumn?: ReactNode
  /** Accessible name for the grid, e.g. "Companies". */
  label: string
  /**
   * What a click anywhere on the row does, when the row's own subject has no
   * page to link to — `/files`, whose rows open a preview modal (a
   * document has no route, by decision). Optional and off by default: every
   * other surface routes from an anchor in its sticky cell, which is the
   * keyboard and middle-click path a bare `onClick` does not give you.
   *
   * A surface that sets this **must** still put a real control in the sticky
   * cell for the keyboard, and any link inside a cell must
   * `stopPropagation()` so a chip click does not also fire this.
   */
  onRowClick?: (row: T) => void
  /**
   * Set only where the rows arrive a page at a time. The foot then counts
   * against the server's total and ends on "load N more" instead of "end" —
   * the same 32px lane, the same two slots, no second table chrome.
   */
  page?: TablePage
  /** The surface's verbs for one column, by its id; none when omitted. */
  columnActions?: (columnId: string) => ReadonlyArray<ColumnAction>
  /** Row checkboxes; absent, the table has none. */
  select?: TableSelect<T>
}) {
  const headRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rows = table.getRowModel().rows
  const keys = select ? rows.map((r) => select.keyOf(r.original)) : []
  const allChecked =
    select !== undefined &&
    keys.length > 0 &&
    select.rows.among(keys).length === keys.length
  // The pinned column sits after the checkbox lane when there is one.
  const stickyLeft = select ? 'left-8' : 'left-0'
  // Both tables: the columns at their widths plus the trailing lane, never
  // narrower than the pane — the trailing lane takes the slack.
  const tableStyle = {
    width: table.getTotalSize() + (select ? SELECT_WIDTH : 0) + TRAILING_WIDTH,
    minWidth: '100%',
  }

  // `isolate`: the pinned head and the pinned column order themselves with
  // small local z values inside one stacking context, so the page's
  // five-step scale never has to climb (DESIGN.md z-index scale).
  return (
    <div role="table" aria-label={label} className="isolate flex flex-col">
      <div
        ref={headRef}
        data-table-head
        // A sideways wheel over the head scrolls the body; the head follows.
        onWheel={(e) => {
          const body = bodyRef.current
          if (body && e.deltaX !== 0) body.scrollLeft += e.deltaX
        }}
        className={cn('overflow-hidden bg-paper', PIN_UNDER_HEAD_BAR)}
      >
        <table
          role="presentation"
          className="table-fixed border-collapse text-ui"
          style={tableStyle}
        >
          <thead role="rowgroup">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} role="row" className="border-b border-hairline">
                {select ? (
                  <th
                    role="columnheader"
                    style={{ width: SELECT_WIDTH }}
                    className="sticky left-0 z-20 bg-paper pl-2.5 align-middle"
                  >
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={(on) => select.rows.set(keys, on)}
                      aria-label={`Select every loaded row of ${label}`}
                    />
                  </th>
                ) : null}
                {hg.headers.map((header) => (
                  <HeaderCell
                    key={header.id}
                    header={header}
                    table={table}
                    sticky={header.column.id === stickyColumnId}
                    stickyLeft={stickyLeft}
                    actions={columnActions?.(header.column.id) ?? []}
                  />
                ))}
                <th role="columnheader" className="px-1 text-left">
                  {addColumn ?? null}
                </th>
              </tr>
            ))}
          </thead>
        </table>
      </div>

      <div
        ref={bodyRef}
        data-table-body
        onScroll={(e) => {
          const head = headRef.current
          if (head) head.scrollLeft = e.currentTarget.scrollLeft
        }}
        className="overflow-x-auto overflow-y-hidden"
      >
        <table
          role="presentation"
          className="table-fixed border-collapse text-ui"
          style={tableStyle}
        >
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr
                key={row.id}
                role="row"
                onClick={
                  onRowClick ? () => onRowClick(row.original) : undefined
                }
                className={cn(
                  'group h-row border-b border-rule transition-colors duration-150 ease-out-quart hover:bg-row-hover',
                  onRowClick && 'cursor-pointer',
                )}
              >
                {select ? (
                  <SelectCell
                    checked={select.rows.has(select.keyOf(row.original))}
                    visible={select.rows.active}
                    name={select.nameOf(row.original)}
                    onChange={(on) =>
                      select.rows.set([select.keyOf(row.original)], on)
                    }
                  />
                ) : null}
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    role="cell"
                    style={{ width: cell.column.getSize() }}
                    className={cn(
                      'h-row px-1 py-0 align-middle',
                      cell.column.id === stickyColumnId &&
                        // Opaque at rest and on hover: a translucent tint here
                        // would let the scrolled-under columns bleed through.
                        'sticky z-10 bg-paper transition-colors duration-150 ease-out-quart group-hover:bg-row-hover',
                      cell.column.id === stickyColumnId && stickyLeft,
                    )}
                  >
                    {/* The row bound: the 36px row less its 1px rule. Content that
                        would grow the row is clipped instead. */}
                    <div
                      data-cell
                      className="flex h-full max-h-[calc(var(--spacing-row)-1px)] min-w-0 flex-col justify-center overflow-hidden"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </div>
                  </td>
                ))}
                <td role="cell" />
              </tr>
            ))}
          </tbody>
          {rows.length > 0 ? (
            // The foot: how much of the ledger is on the page, and where it ends.
            <tfoot role="rowgroup">
              <tr role="row" className="h-8 border-t border-hairline">
                <td
                  role="cell"
                  colSpan={
                    table.getVisibleLeafColumns().length + 1 + (select ? 1 : 0)
                  }
                  className="px-2 align-middle"
                >
                  <div className="flex items-center justify-between">
                    <span className="label-caps font-normal text-graphite">
                      {grouped(rows.length)} of{' '}
                      {grouped(
                        page
                          ? page.total
                          : table.getPreFilteredRowModel().rows.length,
                      )}
                    </span>
                    {page?.hasMore ? (
                      <button
                        type="button"
                        onClick={page.onLoadMore}
                        disabled={page.loading}
                        className="focus-ring mono text-micro text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground disabled:text-graphite"
                      >
                        {page.loading
                          ? 'loading…'
                          : `load ${grouped(page.step)} more`}
                      </button>
                    ) : (
                      <span className="mono text-micro text-graphite">end</span>
                    )}
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
    </div>
  )
}

/** One row's checkbox, shown on hover, focus, or while any row is checked. */
function SelectCell({
  checked,
  visible,
  name,
  onChange,
}: {
  checked: boolean
  visible: boolean
  name: string
  onChange: (on: boolean) => void
}) {
  return (
    <td
      role="cell"
      onClick={(e) => e.stopPropagation()}
      style={{ width: SELECT_WIDTH }}
      className="sticky left-0 z-10 h-row bg-paper py-0 pl-2.5 align-middle transition-colors duration-150 ease-out-quart group-hover:bg-row-hover"
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onChange}
        aria-label={`Select ${name}`}
        className={cn(
          'group-hover:opacity-100 focus-visible:opacity-100',
          checked || visible ? 'opacity-100' : 'opacity-0',
        )}
      />
    </td>
  )
}

function HeaderCell<T>({
  header,
  table,
  sticky,
  stickyLeft,
  actions,
}: {
  header: Header<T, unknown>
  table: Table<T>
  sticky: boolean
  /** The pinned column's offset: after the checkbox lane, or the edge. */
  stickyLeft: string
  actions: ReadonlyArray<ColumnAction>
}) {
  const { column } = header
  const sorted = column.getIsSorted()
  const numeric = column.columnDef.meta?.numeric === true
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
      role="columnheader"
      style={{ width: header.getSize() }}
      aria-sort={
        sorted === 'asc'
          ? 'ascending'
          : sorted === 'desc'
            ? 'descending'
            : 'none'
      }
      className={cn(
        'relative h-8 px-2 align-middle label-caps text-graphite',
        numeric ? 'text-right' : 'text-left',
        sticky && 'sticky z-20 bg-paper',
        sticky && stickyLeft,
      )}
    >
      {column.getCanSort() || column.getCanHide() || actions.length > 0 ? (
        // Header cells are buttons: the menu carries sort both ways and hide.
        // The sort direction reads as a mono arrow after the label; the
        // chevron only appears on hover, so a resting header stays quiet.
        <DropdownMenu>
          <DropdownMenuTrigger
            title={`${title} column`}
            className={cn(
              'group/sort focus-ring-inset -mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-1.5 truncate px-2 transition-colors duration-150 ease-out-quart hover:bg-bone data-[state=open]:bg-bone',
              // A figures column reads from the right, label last.
              numeric ? 'flex-row-reverse text-right' : 'text-left',
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
            {actions.length > 0 &&
            (column.getCanSort() || column.getCanHide()) ? (
              <DropdownMenuSeparator />
            ) : null}
            {actions.map((a) => (
              <DropdownMenuItem key={a.label} onSelect={a.onSelect}>
                {a.label}
              </DropdownMenuItem>
            ))}
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
 * The right lane of a list's bar: Sort · Columns · the text box, in that
 * order, after the views' Filter. One lane for every list, object or shelf.
 */
export function TableTools<T>({
  table,
  filter,
  onFilterChange,
  filterPlaceholder,
  filterLabel,
}: {
  table: Table<T>
  filter: string
  onFilterChange: (value: string) => void
  filterPlaceholder: string
  filterLabel: string
}) {
  return (
    <>
      <SortMenu table={table} />
      <ColumnsMenu table={table} />
      <Input
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        placeholder={filterPlaceholder}
        aria-label={filterLabel}
        className="ml-1 h-7 w-52 bg-paper text-ui"
      />
    </>
  )
}

/** The column's own label, for a menu that names it. */
function columnTitle<T>(c: Column<T, unknown>): string {
  return typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id
}

/**
 * Sort by one column, either way — the same single sort the column heads'
 * menus set, from the bar.
 */
export function SortMenu<T>({ table }: { table: Table<T> }) {
  const current = table.getState().sorting.at(0)
  const desc = current?.desc === true
  const sortable = table.getVisibleLeafColumns().filter((c) => c.getCanSort())
  const active = sortable.find((c) => c.id === current?.id)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant={active ? 'outline' : 'ghost'}>
          <ArrowUpDown className="size-3" strokeWidth={2} />
          Sort
          {active ? (
            <span className="text-graphite">
              {columnTitle(active)} {desc ? '↓' : '↑'}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-56 overflow-y-auto"
      >
        {sortable.map((c) => {
          const on = c.id === current?.id
          return (
            <DropdownMenuItem
              key={c.id}
              // A second pick of the sorted column turns it round.
              onSelect={() => c.toggleSorting(on && !desc)}
            >
              {columnTitle(c)}
              {on ? (
                <span className="ml-auto mono text-micro text-graphite">
                  {desc ? '↓' : '↑'}
                </span>
              ) : null}
            </DropdownMenuItem>
          )
        })}
        {active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => table.resetSorting(true)}>
              Clear sort
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Show and hide columns; the count says how many of them are on. */
export function ColumnsMenu<T>({ table }: { table: Table<T> }) {
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide())
  const hiddenCount = hideable.filter((c) => !c.getIsVisible()).length
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant={hiddenCount > 0 ? 'outline' : 'ghost'}>
          <Columns3 className="size-3" strokeWidth={2} />
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
            {columnTitle(c)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A shelf's bar — a list with no saved views: its own filter as real tabs on
 * the bone bar (`All · Unfiled`, or one `All` with the count), and the
 * table's tools right. An object list's bar is `ViewBar`.
 */
export function TableToolbar<T, TKey extends string>({
  table,
  label,
  tabs,
  value,
  onValueChange,
  filter,
  onFilterChange,
  filterPlaceholder,
  filterLabel,
}: {
  table: Table<T>
  /** Names the tablist — "Files by filing". */
  label: string
  tabs: ReadonlyArray<TabItem<TKey>>
  value: TKey
  onValueChange: (id: TKey) => void
  filter: string
  onFilterChange: (value: string) => void
  filterPlaceholder: string
  filterLabel: string
}) {
  return (
    <Tabs
      label={label}
      size="head"
      items={tabs}
      value={value}
      onValueChange={onValueChange}
      trail={
        <>
          <span className="flex-1" />
          <TableTools
            table={table}
            filter={filter}
            onFilterChange={onFilterChange}
            filterPlaceholder={filterPlaceholder}
            filterLabel={filterLabel}
          />
        </>
      }
    />
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
