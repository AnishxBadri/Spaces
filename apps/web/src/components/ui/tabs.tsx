import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { PIN_UNDER_HEAD_BAR } from '#/components/head-fold'
import { cn } from '#/lib/utils'

/**
 * Folder tabs on white: a 44px bar on a rule, no band. The open tab is
 * outlined in ink on three sides and runs straight into the content under
 * it; a closed tab is plain text. The bar keeps the 4px gutter, so a tab's
 * label sits on the 12px edge and the open tab's outline on the card's.
 * Labels are sentence-case sans. A tab that holds something
 * carries its mono count in ink; an empty one stays in the bar with no
 * count, graphite until hovered.
 * - Keyboard: ←→ move and wrap, Home/End jump, and moving selects (automatic
 *   activation). Only the open tab is in the tab order.
 * - A nested switch under the bar is a `Segmented`, never a second tab row.
 * - `pinned` keeps the head under the folded `HeadBar` while its body
 *   scrolls.
 * - `trail` sits on the same bar after the tabs, outside the tablist: a
 *   list's toolbar (`TabDivider`, Filter, Sort, the search box). It ends
 *   12px from the right, level with the head's `···`.
 * - A switch transitions the text colour only: the open tab's ink fill
 *   switches at once, so no frame shows two half-inked tabs.
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

  // No overflow clip: the open tab hangs 1px over this foot rule. The rule
  // is a `before:` so it spans the gutter-inset card below, not the page,
  // and paints under the open tab rather than over it.
  const bar = cn(
    'relative flex h-11 items-end bg-paper px-1 pt-1 before:absolute before:inset-x-1 before:bottom-0 before:h-px before:bg-rule',
    pinned && PIN_UNDER_HEAD_BAR,
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
              'focus-ring-inset flex shrink-0 items-center gap-2 px-2 text-ui whitespace-nowrap transition-[color] duration-150 ease-out-quart disabled:opacity-50',
              // Open: a pixel taller and a pixel low, so its paper covers
              // the bar's foot rule. Closed: ink when it holds something,
              // graphite when empty.
              open
                ? 'tab-open top-px h-10 text-foreground'
                : counted || t.uncounted === true
                  ? 'h-9.75 text-foreground'
                  : 'h-9.75 text-graphite hover:text-foreground',
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
          <div className="flex min-w-0 flex-1 items-center gap-1 self-stretch pr-2 pb-1">
            {trail}
          </div>
        </div>
      )}
      {children !== undefined ? (
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(selected)}
          className="bg-paper"
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}
