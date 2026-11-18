import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  PIN_UNDER_HEAD_BAR,
  PIN_UNDER_HEAD_BAR_NARROW,
} from '#/components/head-fold'
import type { FolderScroll } from '#/lib/folder-scroll'
import { cn } from '#/lib/utils'

/**
 * The folder: the page's one ink object. A 44px bar on the ground — no
 * fill, a hairline along its foot — whose open tab is paper with a hairline
 * top, left and right, standing on the foot line so its paper covers the
 * line and runs straight into the body under it (`FolderBody`, or the
 * `tabpanel` it renders for `children`); a closed tab is plain text on the
 * ground. The caller sets the bar on the gutter (`FolderGround`, or a column
 * that already has it), so the open tab's left edge is the body's, and a
 * tab's 12px pad puts its label on the 24px edge.
 * Labels are sentence-case sans. A tab that holds something carries its
 * mono count in ink; an empty one stays in the bar with no count, graphite
 * until hovered.
 * - `plain` is the inner bar of a page that already has a folder, inside a
 *   rule card: a rule foot and a rule-outlined open tab, never ink.
 * - Keyboard: ←→ move and wrap, Home/End jump, and moving selects (automatic
 *   activation). Only the open tab is in the tab order.
 * - A nested switch under the bar is a `Segmented`, never a second tab row.
 * - Tabs wider than the bar, a space's six on a phone, scroll sideways
 *   inside it, never the page; the open tab is kept in view.
 * - `pinned` keeps the bar under the folded `HeadBar` while its body
 *   scrolls, on bone so nothing shows through it.
 * - `pane` is a tabbed record's fixed pane: at `xl` the body takes the
 *   height left under the bar and scrolls inside it (`data-folder-scroll`),
 *   while the bar never moves, so `pinned` holds only below `xl`.
 * - `trail` sits on the same bar after the tabs, outside the tablist: a
 *   list's toolbar (`TabDivider`, Filter, Sort, the search box). It ends
 *   12px in from the folder's right edge, level with the head's `···`;
 *   `flush`, it ends on the edge itself, so a list's search box lines up
 *   with the table card's right border under it.
 * - A switch transitions the text colour only: the open tab's fill
 *   switches at once, so no frame shows two half-drawn tabs.
 *
 * Generic over the tab ids so a caller with a union gets it back in
 * `onValueChange`.
 */
export type TabItem<T extends string> = {
  id: T
  label: ReactNode
  /** The mono count beside the label; none is printed at 0. */
  count?: number | undefined
  /**
   * Print a 0 count too: a filtered view whose filter matched nothing,
   * where the 0 is the news. Every other tab hides its 0.
   */
  showZero?: boolean | undefined
  /**
   * Holds something that has no number (a record's Overview): ink when
   * closed, like a counted tab, with no count printed.
   */
  uncounted?: boolean | undefined
  /** Drawn after the count: a view's unsaved-changes square. */
  suffix?: ReactNode
}

/** Where a key moves the selection from `current` among `count` tabs, or
 *  null when the key is not one the tablist answers. */
export function nextTabIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** The rule between a list's tabs and its tools. */
export function TabDivider() {
  return (
    <span
      aria-hidden
      data-tab-divider
      className="mx-1.5 h-4 w-px shrink-0 bg-rule"
    />
  )
}

export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  label,
  disabled,
  pinned = false,
  pane,
  plain = false,
  trail,
  flush = false,
  labelId,
  children,
  className,
}: {
  /** The body's scroller at `xl`, from `useFolderScroll`. */
  pane?: FolderScroll | undefined
  items: ReadonlyArray<TabItem<T>>
  value: T
  onValueChange: (id: T) => void
  /** Names the tablist for screen readers. */
  label: string
  disabled?: boolean | undefined
  /** Stick under the folded head bar while the page scrolls. */
  pinned?: boolean | undefined
  /** The inner bar of a page that has a folder already: rule, not ink. */
  plain?: boolean | undefined
  /** Controls on the bar after the tabs; never inside the tablist. */
  trail?: ReactNode
  /** The trail ends on the folder's right edge: a list's search box. */
  flush?: boolean | undefined
  /**
   * The open tab's label carries this id, so what the tab shows (a list's
   * table) can be named by it; the count stays out of the name.
   */
  labelId?: string | undefined
  /** The open tab's body; rendered as its `tabpanel` when given. */
  children?: ReactNode
  className?: string | undefined
}) {
  const base = useId()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const tabId = (i: number) => `${base}-tab-${i}`
  const panelId = `${base}-panel`
  const selected = Math.max(
    0,
    items.findIndex((t) => t.id === value),
  )

  // The open tab is brought into the bar whenever it changes, a deep link
  // included; only the bar scrolls, never the window.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const bar = scrollRef.current
    const open = refs.current[selected]
    if (!bar || !open) return
    const start = open.offsetLeft
    const end = start + open.offsetWidth
    if (start < bar.scrollLeft) bar.scrollLeft = start
    else if (end > bar.scrollLeft + bar.clientWidth)
      bar.scrollLeft = end - bar.clientWidth
  }, [selected])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(e.key, selected, items.length)
    const item = next === null ? undefined : items[next]
    if (next === null || !item) return
    e.preventDefault()
    if (item.id !== value) onValueChange(item.id)
    refs.current[next]?.focus()
  }

  // The open tab stands on this foot line. The line is a `before:` so it
  // paints under the open tab rather than over it.
  const line = cn(
    'relative flex h-11 items-end before:absolute before:inset-x-0 before:bottom-0 before:h-px',
    plain ? 'before:bg-rule' : 'before:bg-hairline',
  )
  const pin = cn(
    pinned &&
      cn('bg-bone', pane ? PIN_UNDER_HEAD_BAR_NARROW : PIN_UNDER_HEAD_BAR),
    pane && 'shrink-0',
  )
  const list = (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      // Alone, the tablist is the line, as wide as its tabs or the bar,
      // whichever is wider, so the line runs under every tab as it scrolls.
      className={
        trail === undefined
          ? cn(line, 'w-max min-w-full')
          : 'flex shrink-0 items-end'
      }
    >
      {items.map((t, i) => {
        const open = i === selected
        const counted =
          t.count !== undefined && (t.count > 0 || t.showZero === true)
        const empty = t.count === 0 && !counted
        const name =
          open && labelId !== undefined ? (
            <span id={labelId}>{t.label}</span>
          ) : (
            t.label
          )
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            id={tabId(i)}
            type="button"
            role="tab"
            aria-selected={open}
            {...(children !== undefined ? { 'aria-controls': panelId } : {})}
            tabIndex={open ? 0 : -1}
            {...(empty ? { 'data-empty': true } : {})}
            disabled={disabled}
            onClick={() => {
              if (!open) onValueChange(t.id)
            }}
            className={cn(
              'focus-ring-inset flex shrink-0 items-center gap-1.5 px-3 text-ui whitespace-nowrap transition-[color] duration-150 ease-out-quart disabled:opacity-50',
              // Open: its foot is the bar's foot line, so its paper covers
              // that line and its ink sides end on it, never below it into
              // the body. Closed: ink when it holds something, graphite when
              // empty.
              open
                ? cn('tab-open h-9 text-foreground', plain && 'tab-open-plain')
                : counted || t.uncounted === true
                  ? 'h-9 text-foreground'
                  : 'h-9 text-graphite hover:text-foreground',
            )}
          >
            {/* The 13px sans label and the 11px mono count share a baseline;
                the pair is centred as one, the suffix centred apart. */}
            {counted ? (
              <span className="inline-flex items-baseline gap-1.5">
                {name}
                <span
                  data-tab-count
                  className="tabular mono text-micro text-foreground"
                >
                  {t.count}
                </span>
              </span>
            ) : (
              name
            )}
            {t.suffix}
          </button>
        )
      })}
    </div>
  )

  return (
    <div
      className={cn('flex flex-col', pane && 'xl:min-h-0 xl:flex-1', className)}
    >
      {trail === undefined ? (
        // Tabs wider than the bar scroll inside it, never the page; the
        // bar's own scrollbar is hidden, the cut-off tab says there is more.
        <div
          ref={scrollRef}
          data-tab-scroll
          className={cn(
            '[scrollbar-width:none] overflow-x-auto overflow-y-hidden',
            pin,
          )}
        >
          {list}
        </div>
      ) : (
        <div data-tab-bar className={cn(line, pin)}>
          {list}
          <div
            data-tab-trail
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-1',
              !flush && 'pr-3',
            )}
          >
            {trail}
          </div>
        </div>
      )}
      {children !== undefined ? (
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(selected)}
          {...(pane
            ? {
                ref: pane.ref,
                onScroll: pane.onScroll,
                'data-folder-scroll': true,
              }
            : {})}
          className={cn(
            'flex flex-1 flex-col',
            plain ? 'bg-paper' : 'folder',
            // In the pane the body scrolls rather than squeezing its rows:
            // each child keeps its own height.
            pane && 'xl:min-h-0 xl:overflow-y-auto xl:*:shrink-0',
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The folder's body when its bar is drawn apart from it — a list's view bar
 * pinned under the head over the table, Notes' tabs over its ledger: paper
 * in the hairline frame, open at the top where the bar closes it.
 */
export function FolderBody({
  children,
  label,
  className,
}: {
  children: ReactNode
  /** Names the body when no heading inside it does. */
  label?: string | undefined
  className?: string | undefined
}) {
  return (
    <section
      data-folder
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cn('flex flex-col folder', className)}
    >
      {children}
    </section>
  )
}
