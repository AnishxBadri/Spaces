import { flexRender } from '@tanstack/react-table'
import type { Column, Header, RowData, Table } from '@tanstack/react-table'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ComponentProps, KeyboardEvent, ReactNode, RefObject } from 'react'
import { FolderGround } from '#/components/page-header'
import { ArrowDown, ArrowUp, ChevronsUpDown, icon } from '#/components/icons'
import type { IconComponent } from '#/components/icons'
import { useHotkey } from '#/lib/use-hotkey'
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
import { TabDivider, Tabs } from '#/components/ui/tabs'
import type { TabItem } from '#/components/ui/tabs'
import { ListFoot } from './list-foot'
import type { ListFootPage } from './list-foot'
import { ListZeroRow } from './list-states'
import type { RowSelection } from './selection-bar'
import { cn } from '#/lib/utils'

declare module '@tanstack/react-table' {
  // A column of comparable figures: its head right-aligns over `numeric` cells.
  interface ColumnMeta<TData extends RowData, TValue> {
    numeric?: boolean
    /** An attribute a model fills: its head carries the `AI` tag. */
    ai?: boolean
  }
}

/**
 * The one record table. Companies, People and Deals are the same object shaped
 * three ways — registry-generated columns over `entity.values` — so they render
 * through one component, and the type scale, focus ring and sort affordance
 * have one place to change.
 * - In scope: show/hide/resize, single sort, sticky header, sticky first
 *   column, row → record, row checkboxes. Deliberately absent: bulk edit,
 *   calculations row, CSV, virtualization.
 * - To a screen reader it is a table named by the page's title and open
 *   view, the sorted head says which way, and the name cell heads its row.
 *   While columns run past the right edge the scroller is one Tab stop,
 *   named for how many, and ← → scroll it.
 *
 * A list is a fixed pane: the table's card fills what the page leaves it and
 * is the one scroller, both ways. The column head holds the card's top, the
 * foot its bottom, the name column its left and a row's trailing lane (its
 * `···`) its right; everything else scrolls under them. The cells keep their
 * own borders (`border-separate`) so a pinned cell's rules travel with it.
 * - Every cell's content is bounded to the 36px row.
 * - The table is the page's folder body (`folder`: a hairline frame under
 *   its tab bar) or, with no tabs over it, a rule card; a line between
 *   columns, its heads white, the cells inset 7px and the row's first lane
 *   11px, on the page's 24px line. Columns is an icon at the end of the
 *   head row.
 */

/** Column widths nudge by this much per arrow-key press. */
const RESIZE_STEP = 16
const MIN_COLUMN_WIDTH = 64
/** The checkbox lane's width: `w-9`, which the pinned column's `left-9` clears. */
const SELECT_WIDTH = 36
/** The trailing lane's floor: the add-column control, or the right margin. */
const TRAILING_WIDTH = 56

/**
 * What a paged surface tells its foot. Absent on every unpaged
 * surface, whose foot reads `getPreFilteredRowModel()` — those tables
 * hold every row they could show, so the pre-filtered model *is* the truth
 * there and a server round trip would only be able to agree with it.
 */
export type TablePage = ListFootPage & {
  /** The server's `count(*)` over the same `where` the page was cut from. */
  total: number
}

/**
 * A surface's own verb in a column's header menu, after sort and hide —
 * "Run on this view" on an AI attribute's column. The menu closes
 * on select, so a verb that opens a dialog keeps the dialog outside it and
 * only flips its state here.
 */
export type ColumnAction = {
  label: string
  onSelect: () => void
  /** Opens a window: runs once the menu has let go of focus. */
  opens?: boolean | undefined
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
  labelledBy,
  onRowClick,
  page,
  columnActions,
  select,
  notice,
  rowEnd,
  rowEndWidth = TRAILING_WIDTH,
  joined = false,
  folder = false,
}: {
  table: Table<T>
  /** Column pinned to the left edge while the rest scrolls under it. */
  stickyColumnId?: string
  /** The "+ Add column" control, rendered in the trailing header cell. */
  addColumn?: ReactNode
  /**
   * The list's noun, "Companies": the table's name when nothing on the
   * page names it, and the start of the sideways pane's name.
   */
  label: string
  /**
   * Ids of what names the table on the page, in reading order: the title,
   * then the open view's tab. Each must be in the DOM; absent or empty,
   * `label` names the table.
   */
  labelledBy?: ReadonlyArray<string> | undefined
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
   * Set only where the rows arrive a page at a time: the foot counts what
   * is loaded of the server's total and offers `Load N more` while another
   * page exists.
   */
  page?: TablePage
  /**
   * Drawn in place of the rows: the list still loading, failed, or a filter
   * that matched nothing with its way out. Absent, an empty table says
   * `Nothing matches that filter.` alone.
   */
  notice?: ReactNode
  /** The surface's verbs for one column, by its id; none when omitted. */
  columnActions?: (columnId: string) => ReadonlyArray<ColumnAction>
  /** Row checkboxes; absent, the table has none. */
  select?: TableSelect<T>
  /**
   * What a row ends on, in the trailing lane pinned to the card's right
   * edge: its `···` (shown on hover), or a shelf's exception lane.
   */
  rowEnd?: (row: T) => ReactNode
  /** The trailing lane's width when a row ends on more than a `···`. */
  rowEndWidth?: number
  /**
   * The table hangs from a tab bar, whose foot line is its top edge and
   * whose open tab runs into it; alone, the box draws its own top edge.
   */
  joined?: boolean | undefined
  /**
   * The table is the body of the page's folder: a hairline frame. Without a
   * tab bar over it the table is a rule card.
   */
  folder?: boolean | undefined
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = table.getRowModel().rows
  const visible = table.getVisibleLeafColumns()
  // The pinned lanes' width from the card's left: the checkbox lane and the
  // name column. A column revealed by `n more columns →` lands after them.
  const pinnedWidth =
    (select ? SELECT_WIDTH : 0) +
    (visible.find((c) => c.id === stickyColumnId)?.getSize() ?? 0)
  const overflow = useColumnOverflow(scrollRef, {
    width: table.getTotalSize(),
    columns: visible.length,
    endWidth: rowEndWidth,
  })
  // ← → move by about one column: the mean of the columns that scroll.
  const scrolling = visible.filter((c) => c.id !== stickyColumnId)
  const columnStep =
    scrolling.length === 0
      ? MIN_COLUMN_WIDTH
      : Math.round(
          scrolling.reduce((x, c) => x + c.getSize(), 0) / scrolling.length,
        )
  // A Tab stop only while there is somewhere to scroll: columns past the
  // right edge, or a scroll already taken that the keyboard must undo.
  const sideways = overflow.hidden > 0 || overflow.scrolled
  const more =
    overflow.hidden > 0
      ? `${overflow.hidden} more column${overflow.hidden === 1 ? '' : 's'}`
      : null
  function onPaneKey(e: KeyboardEvent<HTMLDivElement>) {
    // A control inside a cell keeps its own arrows.
    if (e.target !== e.currentTarget) return
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const by =
      e.key === 'ArrowRight'
        ? columnStep
        : e.key === 'ArrowLeft'
          ? -columnStep
          : 0
    if (by === 0) return
    e.preventDefault()
    overflow.scrollBy(by)
  }
  const named =
    labelledBy !== undefined && labelledBy.length > 0
      ? { 'aria-labelledby': labelledBy.join(' ') }
      : { 'aria-label': label }
  const resizing = table.getState().columnSizingInfo.isResizingColumn
  // The dragged column's right edge, from the table's left: where the guide
  // runs while the drag lasts.
  const guideAt =
    resizing === false
      ? null
      : (() => {
          const at = visible.findIndex((c) => c.id === resizing)
          if (at === -1) return null
          return visible
            .slice(0, at + 1)
            .reduce((x, c) => x + c.getSize(), select ? SELECT_WIDTH : 0)
        })()
  const instead = notice ?? (rows.length === 0 ? <ListZeroRow /> : null)
  const keys = select ? rows.map((r) => select.keyOf(r.original)) : []
  const allChecked =
    select !== undefined &&
    keys.length > 0 &&
    select.rows.among(keys).length === keys.length
  // The pinned column sits after the checkbox lane when there is one.
  const stickyLeft = select ? 'left-9' : 'left-0'
  // The columns at their widths plus the trailing lane, never narrower than
  // the card — the trailing lane takes the slack.
  const tableStyle = {
    width: table.getTotalSize() + (select ? SELECT_WIDTH : 0) + rowEndWidth,
    minWidth: '100%',
  }

  // `isolate`: the pinned head, column and lane order themselves with small
  // local z values inside one stacking context, so the page's five-step
  // z-index scale never has to climb. Body pins sit at 10, the head at 20,
  // the head's own pinned corners at 30, a focused pane's marks at 40.
  return (
    <div
      data-table-box
      data-frame={folder ? 'folder' : 'card'}
      className={cn(
        'isolate flex min-h-0 flex-1 flex-col border-x border-b bg-paper',
        folder ? 'border-hairline' : 'border-rule',
        !joined && 'border-t',
      )}
    >
      {/* The frame draws the scroller's focus marks: on the scroller they
          would scroll away with the rows and sit under its pinned lanes. */}
      <div className="focus-ring-pane relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-table-scroller
          data-focus-pane
          onScroll={overflow.check}
          {...(sideways
            ? {
                role: 'group',
                tabIndex: 0,
                'aria-label': more === null ? label : `${label}, ${more}`,
                onKeyDown: onPaneKey,
              }
            : {})}
          className="relative min-h-0 flex-1 overflow-auto"
        >
          <table
            role="table"
            {...named}
            className="table-fixed border-separate border-spacing-0 text-ui"
            style={tableStyle}
          >
            <thead role="rowgroup" data-table-head>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} role="row">
                  {select ? (
                    <th
                      role="columnheader"
                      style={{ width: SELECT_WIDTH }}
                      className={cn(HEAD_CELL, 'left-0 z-30 pl-2.75')}
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
                  <th
                    role="columnheader"
                    data-head-end
                    style={{ minWidth: rowEndWidth }}
                    className={cn(HEAD_CELL, 'right-0 z-30 px-1')}
                  >
                    <div className="flex items-center justify-end gap-0.5">
                      {addColumn ?? null}
                      <ColumnsMenu table={table} />
                    </div>
                  </th>
                </tr>
              ))}
            </thead>
            <tbody role="rowgroup">
              {instead !== null
                ? null
                : rows.map((row) => (
                    <tr
                      key={row.id}
                      role="row"
                      data-row
                      onClick={
                        onRowClick ? () => onRowClick(row.original) : undefined
                      }
                      className={cn(
                        'group h-row transition-colors duration-150 ease-out-quart hover:bg-row-hover',
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
                          // The name cell heads its row: moving along the
                          // row reads the record's name with each value.
                          role={
                            cell.column.id === stickyColumnId
                              ? 'rowheader'
                              : 'cell'
                          }
                          style={{ width: cell.column.getSize() }}
                          className={cn(
                            'h-row border-r border-b border-rule px-0.75 py-0 align-middle first:pl-1.75',
                            cell.column.id === stickyColumnId &&
                              cn(BODY_PIN, stickyLeft),
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
                      <td
                        role="cell"
                        data-row-end
                        onClick={
                          rowEnd ? (e) => e.stopPropagation() : undefined
                        }
                        style={{ minWidth: rowEndWidth }}
                        className={cn(
                          'h-row border-b border-rule px-1 py-0 align-middle',
                          BODY_PIN,
                          'right-0',
                        )}
                      >
                        {rowEnd ? rowEnd(row.original) : null}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>

          {instead}
        </div>
        {guideAt === null ? null : (
          <ResizeGuide at={guideAt} scroller={scrollRef} />
        )}
        {overflow.hidden > 0 ? (
          // Over the last columns that show, before the pinned trailing lane.
          <div
            aria-hidden
            data-table-fade
            style={{ right: rowEndWidth }}
            className="pointer-events-none absolute inset-y-0 z-10 w-6 bg-linear-to-l from-paper to-transparent"
          />
        ) : null}
      </div>
      <ListFoot
        folder={folder}
        {...(instead === null
          ? {
              count: {
                shown: rows.length,
                total:
                  page?.total ?? table.getPreFilteredRowModel().rows.length,
              },
            }
          : {})}
        {...(page === undefined ? {} : { page })}
        end={
          more === null ? null : (
            <button
              type="button"
              data-more-columns
              onClick={() => overflow.reveal(pinnedWidth)}
              className="focus-ring shrink-0 rounded-md text-label text-graphite underline-offset-4 hover:text-foreground hover:underline"
            >
              {more} →
            </button>
          )
        }
      />
    </div>
  )
}

/** Every head cell: pinned to the card's top, opaque over the rows. */
const HEAD_CELL = 'sticky top-0 border-b border-rule bg-paper'

/**
 * A body cell pinned while the row scrolls sideways under it: opaque at rest
 * and on hover, since a translucent tint would let the scrolled-under
 * columns bleed through.
 */
const BODY_PIN =
  'sticky z-10 bg-paper transition-colors duration-150 ease-out-quart group-hover:bg-row-hover'

/**
 * The dashed line a column drag draws, over the visible card from head to
 * foot. Placed against the card rather than inside the scroller, so it never
 * scrolls away under a long list; it follows a sideways scroll.
 */
function ResizeGuide({
  at,
  scroller,
}: {
  /** The dragged column's right edge, from the table's left. */
  at: number
  scroller: RefObject<HTMLDivElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    const guide = ref.current
    if (!el || !guide) return
    const place = () => {
      guide.style.left = `${at - 1 - el.scrollLeft}px`
    }
    place()
    el.addEventListener('scroll', place, { passive: true })
    return () => el.removeEventListener('scroll', place)
  }, [at, scroller])
  return (
    <div
      ref={ref}
      aria-hidden
      data-resize-guide
      className="pointer-events-none absolute inset-y-0 z-20 border-l border-dashed border-foreground"
    />
  )
}

/**
 * How many columns lie past the card's right edge — under the pinned
 * trailing lane or beyond it — whether the card is scrolled sideways, and
 * the steps that move it: the first hidden column in, or a distance either
 * way. Rechecked on scroll, on resize and when the columns change. The fade,
 * the foot's `n more columns →` and the scroller's Tab stop all read it.
 */
function useColumnOverflow(
  ref: RefObject<HTMLDivElement | null>,
  {
    width,
    columns,
    endWidth,
  }: {
    /** The columns' total width: a resize moves the count. */
    width: number
    /** How many columns show: hiding one moves the count. */
    columns: number
    /** The pinned trailing lane, which covers whatever scrolls under it. */
    endWidth: number
  },
): {
  hidden: number
  scrolled: boolean
  check: () => void
  reveal: (pinnedWidth: number) => void
  scrollBy: (left: number) => void
} {
  const [hidden, setHidden] = useState(0)
  const [scrolled, setScrolled] = useState(false)
  const past = useCallback(
    (el: HTMLDivElement) => {
      // Not laid out (hidden, or a DOM with no layout): nothing to count.
      if (el.clientWidth === 0) return []
      const edge = el.scrollLeft + el.clientWidth - endWidth
      return [...el.querySelectorAll('[data-column]')].filter(
        (th): th is HTMLElement =>
          th instanceof HTMLElement &&
          th.offsetLeft + th.offsetWidth > edge + 1,
      )
    },
    [endWidth],
  )
  const check = useCallback(() => {
    const el = ref.current
    if (!el) return
    setHidden(past(el).length)
    setScrolled(el.scrollLeft > 0)
  }, [ref, past])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, check, width, columns])
  const behavior = (): ScrollBehavior =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
  const reveal = (pinnedWidth: number) => {
    const el = ref.current
    const next = el ? past(el).at(0) : undefined
    if (!el || !next) return
    el.scrollTo({ left: next.offsetLeft - pinnedWidth, behavior: behavior() })
  }
  const scrollBy = (left: number) =>
    ref.current?.scrollBy({ left, behavior: behavior() })
  return { hidden, scrolled, check, reveal, scrollBy }
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
      className={cn(
        BODY_PIN,
        'left-0 h-row border-b border-rule py-0 pl-2.75 align-middle',
      )}
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

/** The head menu's affordance, shown on hover, focus or while open. */
function SortChevron({ className }: { className: string }) {
  return (
    <ChevronsUpDown
      className={cn(
        'size-4 shrink-0 opacity-0 transition-opacity duration-150 ease-out-quart group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100 group-data-[state=open]/sort:opacity-100',
        className,
      )}
      aria-hidden
    />
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
  const afterClose = useRef<(() => void) | null>(null)
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
      {...(sticky ? {} : { 'data-column': true })}
      className={cn(
        // The row's first lane insets 11px, on the page's 24px line.
        HEAD_CELL,
        'h-8 border-r px-1.75 align-middle text-label font-normal text-graphite first:pl-2.75',
        numeric ? 'text-right' : 'text-left',
        sticky ? cn('z-30', stickyLeft) : 'z-20',
      )}
    >
      {column.getCanSort() || column.getCanHide() || actions.length > 0 ? (
        // Header cells are buttons: the menu carries sort both ways and hide.
        // The sorted head is ink with its arrow after the label; the
        // chevron only appears on hover, so a resting header stays quiet.
        <DropdownMenu>
          <DropdownMenuTrigger
            title={`${title} column`}
            className={cn(
              'group/sort focus-ring-inset -mx-1.75 flex h-8 w-[calc(100%+0.875rem)] items-center gap-1.5 truncate px-1.75 transition-colors duration-150 ease-out-quart hover:bg-bone data-[state=open]:bg-bone',
              // In the first lane the trigger still reaches the frame.
              'in-[th:first-child]:-ml-2.75 in-[th:first-child]:w-[calc(100%+1.125rem)] in-[th:first-child]:pl-2.75',
              numeric ? 'text-right' : 'text-left',
              sorted && 'text-foreground',
            )}
          >
            {/* A figures column reads from the right: the chevron leads. */}
            {numeric ? <SortChevron className="mr-auto" /> : null}
            <span className="truncate">
              {flexRender(column.columnDef.header, header.getContext())}
            </span>
            {column.columnDef.meta?.ai === true ? <AiTag /> : null}
            {/* Drawn in currentColor rather than a text glyph, so it holds in
                forced colours; `aria-sort` on the head says the direction. */}
            {sorted === 'asc' ? (
              <ArrowUp aria-hidden className="size-4 shrink-0" />
            ) : sorted === 'desc' ? (
              <ArrowDown aria-hidden className="size-4 shrink-0" />
            ) : null}
            {numeric ? null : <SortChevron className="ml-auto" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-50"
            onCloseAutoFocus={(e) => {
              const run = afterClose.current
              if (run === null) return
              e.preventDefault()
              afterClose.current = null
              run()
            }}
          >
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
              <DropdownMenuItem
                key={a.label}
                onSelect={() => {
                  if (a.opens === true) afterClose.current = a.onSelect
                  else a.onSelect()
                }}
              >
                {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="flex items-center gap-1.5 truncate">
          <span className="truncate">
            {flexRender(column.columnDef.header, header.getContext())}
          </span>
          {column.columnDef.meta?.ai === true ? <AiTag /> : null}
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
 * A bar tool. With an `icon` (Filter, Sort, Columns) it is the bare icon at
 * rest, named by `label`, and an outline box reading its state only while
 * in use (`Filter 2`, `Last contact ↓`); the children are that state.
 * Without one (Deals' Stage chip) the children always print.
 */
export function ToolButton({
  active,
  icon: Icon,
  label,
  className,
  children,
  ...props
}: ComponentProps<'button'> & {
  active: boolean
  icon?: IconComponent | undefined
  /** The tool's name: its accessible name and tooltip when it is an icon. */
  label?: string | undefined
}) {
  const bare = Icon !== undefined && !active
  return (
    <button
      type="button"
      data-tool-active={active}
      {...(label === undefined ? {} : { 'aria-label': label, title: label })}
      {...props}
      className={cn(
        'focus-ring flex h-6.5 shrink-0 items-center gap-1.5 rounded-md border text-ui whitespace-nowrap text-foreground transition-colors duration-150 ease-out-quart',
        bare ? 'w-6.5 justify-center' : 'px-2',
        active
          ? 'border-hairline bg-paper hover:bg-bone'
          : 'border-transparent hover:bg-bone data-[state=open]:bg-bone',
        className,
      )}
    >
      {Icon === undefined ? null : <Icon aria-hidden className="size-4" />}
      {bare ? null : children}
    </button>
  )
}

/** The tag on an AI attribute's column head. */
function AiTag() {
  return (
    <span className="shrink-0 border border-rule px-1 mono text-field text-graphite">
      AI
    </span>
  )
}

/**
 * What the bar shows right after Sort: an object list's Save view controls,
 * handed down by `ViewBar` so the page's `TableTools` need not carry them.
 */
export const AfterSort = createContext<ReactNode>(null)

/**
 * The rest of a list's bar after the views' Filter: Sort, then the search box
 * alone at the right with its `/`. Columns is not here: it ends the column
 * head row. One lane for every list, object or shelf.
 */
export function TableTools<T>({
  table,
  filter,
  onFilterChange,
  filterPlaceholder,
  filterLabel,
  beforeSearch,
}: {
  table: Table<T>
  filter: string
  onFilterChange: (value: string) => void
  filterPlaceholder: string
  filterLabel: string
  /** A list's own switch, right, before the search box. */
  beforeSearch?: ReactNode
}) {
  const afterSort = useContext(AfterSort)
  const search = useRef<HTMLInputElement>(null)
  useHotkey('/', () => search.current?.focus())
  return (
    <>
      <SortMenu table={table} />
      {afterSort}
      <span className="flex-1" />
      {beforeSearch}
      <span className="relative ml-1 flex shrink-0 items-center">
        <Input
          ref={search}
          type="search"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={filterPlaceholder}
          aria-label={filterLabel}
          aria-keyshortcuts="/"
          className="h-6.5 w-45 bg-paper pr-6 text-ui"
        />
        {filter === '' ? (
          <kbd
            aria-hidden
            data-search-key
            className="pointer-events-none absolute right-1.5 border border-rule px-1 mono text-field text-graphite"
          >
            /
          </kbd>
        ) : null}
      </span>
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
        <ToolButton
          active={active !== undefined}
          icon={icon.sort}
          label="Sort"
          data-tool="sort"
        >
          {active ? `${columnTitle(active)} ${desc ? '↓' : '↑'}` : null}
        </ToolButton>
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

/**
 * Show and hide columns, from an icon at the end of the column head row;
 * the menu's head says how many are on.
 */
export function ColumnsMenu<T>({ table }: { table: Table<T> }) {
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide())
  const hiddenCount = hideable.filter((c) => !c.getIsVisible()).length
  if (hideable.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Columns"
          title="Columns"
          data-columns-menu
          className="focus-ring flex size-6 items-center justify-center rounded-md text-graphite transition-colors duration-150 ease-out-quart hover:bg-bone hover:text-foreground data-[state=open]:bg-bone"
        >
          <icon.columns aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-60 overflow-y-auto p-0"
      >
        <div className="flex h-8 items-center justify-between border-b border-rule px-2.5">
          <DropdownMenuLabel className="p-0 label-caps text-foreground">
            Columns · {hideable.length - hiddenCount} of {hideable.length}
          </DropdownMenuLabel>
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => table.resetColumnVisibility()}
              className="focus-ring rounded-md text-label text-graphite hover:text-foreground"
            >
              Reset
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
 * A shelf's bar — a list with no saved views: its own filter as folder tabs
 * (`All · Unfiled`, or one `All` with the count), a divider, Sort, and the
 * search box right on the card's edge, on the ground over the table. An
 * object list's bar is `ViewBar`.
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
  labelId,
}: {
  table: Table<T>
  /** Names the tablist — "Files by filing". */
  label: string
  /** The open tab's label carries this id: the table names itself by it. */
  labelId?: string | undefined
  tabs: ReadonlyArray<TabItem<TKey>>
  value: TKey
  onValueChange: (id: TKey) => void
  filter: string
  onFilterChange: (value: string) => void
  filterPlaceholder: string
  filterLabel: string
}) {
  return (
    <FolderGround>
      <Tabs
        label={label}
        items={tabs}
        value={value}
        onValueChange={onValueChange}
        flush
        labelId={labelId}
        trail={
          <>
            <TabDivider />
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
    </FolderGround>
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
      <icon.new className="size-4" />
    </button>
  )
}
