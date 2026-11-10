import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { PIN_UNDER_HEAD_BAR } from '#/components/head-fold'
import { cn } from '#/lib/utils'

/**
 * The folder: the page's one ink object. A 44px bar on the ground — no
 * fill, a hairline along its foot — whose open tab is paper with a hairline
 * top, left and right, a pixel taller than the bar so it covers the foot
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
 * - `pinned` keeps the bar under the folded `HeadBar` while its body
 *   scrolls, on bone so nothing shows through it.
 * - `trail` sits on the same bar after the tabs, outside the tablist: a
 *   list's toolbar (`TabDivider`, Filter, Sort, the search box). It ends
 *   12px in from the folder's right edge, level with the head's `···`.
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
  plain = false,
  trail,
  children,
  className,
}: {
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

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(e.key, selected, items.length)
    const item = next === null ? undefined : items[next]
    if (next === null || !item) return
    e.preventDefault()
    if (item.id !== value) onValueChange(item.id)
    refs.current[next]?.focus()
  }

  // No overflow clip: the open tab hangs 1px over this foot line. The line
  // is a `before:` so it paints under the open tab rather than over it.
  const bar = cn(
    'relative flex h-11 items-end before:absolute before:inset-x-0 before:bottom-0 before:h-px',
    plain ? 'before:bg-rule' : 'before:bg-hairline',
    pinned && cn('bg-bone', PIN_UNDER_HEAD_BAR),
  )
  const list = (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={trail === undefined ? bar : 'flex shrink-0 items-end'}
    >
      {items.map((t, i) => {
        const open = i === selected
        const counted =
          t.count !== undefined && (t.count > 0 || t.showZero === true)
        const empty = t.count === 0 && !counted
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
              // Open: a pixel taller and a pixel low, so its paper covers
              // the bar's foot line. Closed: ink when it holds something,
              // graphite when empty.
              open
                ? cn(
                    'tab-open top-px h-9.25 text-foreground',
                    plain && 'tab-open-plain',
                  )
                : counted || t.uncounted === true
                  ? 'h-9 text-foreground'
                  : 'h-9 text-graphite hover:text-foreground',
            )}
          >
            {t.label}
            {counted ? (
              <span
                data-tab-count
                className="tabular mono text-micro text-foreground"
              >
                {t.count}
              </span>
            ) : null}
            {t.suffix}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className={cn('flex flex-col', className)}>
      {trail === undefined ? (
        list
      ) : (
        <div data-tab-bar className={bar}>
          {list}
          <div className="flex h-9 min-w-0 flex-1 items-center gap-1 pr-3">
            {trail}
          </div>
        </div>
      )}
      {children !== undefined ? (
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(selected)}
          className={cn('flex flex-1 flex-col', plain ? 'bg-paper' : 'folder')}
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
