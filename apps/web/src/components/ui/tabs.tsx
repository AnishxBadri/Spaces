import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { PIN_UNDER_HEAD_BAR } from '#/components/head-fold'
import { cn } from '#/lib/utils'

/**
 * Real tabs: a bone bar on a hairline foot;
 * the open tab is paper with a straight ink edge, joined to the body under it with
 * no rule between, and the others sit on the bone in ink. Each tab may carry
 * its mono count, and an empty tab stays visible, graphite at 0: the
 * head stays the index.
 * - Keyboard: ←→ move and wrap, Home/End jump, and moving selects (automatic
 *   activation). Only the open tab is in the tab order.
 * - Filter rows under a tab keep the underline grammar; this is the tab head.
 * - `size="head"` is a record body's 44px head, the height of a section's
 *   bone band; the default bar is 36px.
 * - `pinned` keeps the head under the folded `HeadBar` while its body
 *   scrolls.
 * - `trail` sits on the same bone bar after the tabs, outside the tablist:
 *   a list's `+ view` and its Filter · Sort · Columns lane.
 * - A switch transitions the text colour only: the open tab's ink fill
 *   switches at once, so no frame shows two half-inked tabs.
 *
 * Generic over the tab ids so a caller with a union gets it back in
 * `onValueChange`.
 */
export type TabItem<T extends string> = {
  id: T
  label: ReactNode
  /** The mono count beside the label; `0` reads graphite. */
  count?: number | undefined
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

export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  label,
  disabled,
  size = 'bar',
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
  size?: 'bar' | 'head' | undefined
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

  // No overflow clip: the open tab hangs 1px over this foot rule.
  const bar = cn(
    'flex items-end border-b border-hairline bg-bone pt-1',
    size === 'head' && 'h-11 px-3',
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
        const empty = t.count === 0
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
              'focus-ring-inset flex shrink-0 items-center gap-2 px-3 label-caps whitespace-nowrap transition-[color] duration-150 ease-out-quart disabled:opacity-50',
              size === 'head' ? 'h-9.75' : 'h-8',
              // Closed: ink when it holds something, graphite when empty.
              open
                ? 'tab-open -mb-px text-foreground'
                : t.count !== undefined && t.count > 0
                  ? 'text-foreground'
                  : 'text-graphite hover:text-foreground',
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span
                data-tab-count
                className={cn(
                  'tabular mono text-micro font-normal',
                  t.count > 0 ? 'text-foreground' : 'text-graphite',
                )}
              >
                {t.count}
              </span>
            ) : null}
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
          <div className="flex min-w-0 flex-1 items-center gap-1 self-stretch pb-1">
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
