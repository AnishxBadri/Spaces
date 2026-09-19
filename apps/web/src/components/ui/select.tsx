import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Command as CommandPrimitive } from 'cmdk'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover.tsx'
import { cn } from '#/lib/utils.ts'

/**
 * The one picker. A native `<select>` renders the operating system's list —
 * rounded on macOS, a different font, a blue system highlight, and on a
 * machine set to dark OS chrome a dark list dropping out of a paper form.
 * DESIGN.md §5 "Menus / pickers" says a picker is paper, 1px ink, a 2px hard
 * shadow, 28px rows, the highlighted row in bone, 150/100ms — which is the
 * sheet the command palette and the attribute type pane already draw. This is
 * that sheet with a trigger in front of it (SPA-38), and it is what every
 * `<select>` in the app became.
 *
 * The anatomy is not new: Radix `Popover` for the layer, dismissal and the
 * reticle-free escape, cmdk `Command` for the list, its roles and its
 * ↑↓/↵ handling — the same two pieces `command.tsx` and `attribute-dialog`'s
 * `TypePane` are built from. `PopoverContent` takes the cmdk root `asChild`,
 * so the element Radix focuses on open **is** the element cmdk listens on,
 * and the arrows work with or without a search box.
 *
 * Three decisions belong to the caller, never to the primitive guessing:
 *
 * - `width` — `'trigger'` locks the sheet to the trigger's width (a two-item
 *   role picker, a three-item status group: short labels, few of them);
 *   `'content'` lets it size to its longest row with the trigger as a floor
 *   (the operator picker, the per-type slots, anything whose labels are
 *   sentences).
 * - `inset` — `focus-ring-inset` instead of `focus-ring`, for a trigger inside
 *   a scroll container, where the offset reticle would be clipped. The view
 *   bar's filter row is the case.
 * - `search` — cmdk's own filter box. It earns its place once the list is long
 *   enough to hunt through (`SEARCH_FROM` rows); below that it is chrome in
 *   front of three words. Defaults by count, overridable either way.
 *
 * Short lists get no search box, so they get letter type-ahead instead — the
 * one `<select>` behaviour cmdk has no answer for without an input, and the
 * reason this handles it rather than losing it.
 */

/** Rows from which a search box is worth more than the space it costs. */
export const SEARCH_FROM = 8

/** How long a type-ahead buffer survives between keystrokes, in ms. */
const TYPEAHEAD_MS = 800

export type SelectItem<T extends string> = {
  value: T
  /** What the row reads as, and what type-ahead and the filter match on. */
  label: string
  /** Extra words cmdk's filter should match — never displayed. */
  keywords?: string | undefined
  disabled?: boolean | undefined
  /** Drawn instead of the label when a row is more than its text. */
  render?: React.ReactNode | undefined
  /** Tree depth; each level indents the row by 12px. */
  depth?: number | undefined
}

/**
 * The class strings a picker is made of, exported the way `badgeClasses` and
 * `switchClasses` are: the contract is asserted against these, not against a
 * rendered tree (`apps/web/vitest.config.ts` runs on `node`, and this slice
 * added no DOM dependency to change that).
 */
export function selectClasses({
  width,
  inset,
  className,
}: {
  width: 'trigger' | 'content'
  inset?: boolean | undefined
  className?: string | undefined
}) {
  return {
    // An Input-height button: same 32px, same rule border, same 2px radius,
    // so a picker and a field in one row share a baseline. The reticle is the
    // only focus treatment (Reticle Rule); inside a scroll container it is
    // drawn inset so the container cannot clip it.
    trigger: cn(
      'group/select flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md border border-rule bg-paper px-2.5 text-left text-ui transition-colors duration-150 ease-out-quart hover:border-hairline disabled:pointer-events-none disabled:opacity-50 data-[state=open]:border-hairline',
      inset ? 'focus-ring-inset' : 'focus-ring',
      className,
    ),
    // The paper sheet: 1px ink edge, the 2px hard offset, no blur, no radius.
    // Enter 150ms, exit 100ms, transform and opacity only (Compositor Rule).
    sheet: cn(
      'z-dropdown flex max-h-72 flex-col overflow-hidden rounded-none border border-hairline bg-paper p-0 text-foreground shadow-[2px_2px_0_0_var(--hairline)] ease-out-quart outline-none',
      'data-[state=open]:animate-in data-[state=open]:duration-150 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
      'data-[state=closed]:animate-out data-[state=closed]:duration-100 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
      width === 'trigger'
        ? 'w-(--radix-popover-trigger-width)'
        : 'w-auto max-w-[min(22rem,var(--radix-popover-content-available-width))] min-w-(--radix-popover-trigger-width)',
    ),
    // 28px rows; the highlighted one is bone and nothing else (No-Bar Rule).
    item: 'relative flex h-7 cursor-default items-center gap-2 rounded-none px-2.5 text-ui outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-bone',
  }
}

type Props<T extends string> = {
  value: T | ''
  onChange: (value: T) => void
  items: ReadonlyArray<SelectItem<T>>
  /** Sheet width behaviour — the caller's judgement, not the primitive's. */
  width: 'trigger' | 'content'
  /** Shown while nothing is chosen; also the label of a `''`-valued picker. */
  placeholder?: string | undefined
  /** Draw the reticle inset — for a trigger inside a scroll container. */
  inset?: boolean | undefined
  /** Force the search box on or off; defaults to `items.length >= SEARCH_FROM`. */
  search?: boolean | undefined
  searchPlaceholder?: string | undefined
  /** What the sheet says when the filter matches nothing. */
  emptyLabel?: string | undefined
  /** Mirrored into a hidden input, for a form read through `FormData`. */
  name?: string | undefined
  id?: string | undefined
  disabled?: boolean | undefined
  className?: string | undefined
  'aria-label'?: string | undefined
}

export function Select<T extends string>({
  value,
  onChange,
  items,
  width,
  placeholder = '—',
  inset,
  search,
  searchPlaceholder = 'Search…',
  emptyLabel = 'No match.',
  name,
  id,
  disabled,
  className,
  'aria-label': ariaLabel,
}: Props<T>) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [highlight, setHighlight] = React.useState<string>(value)
  const typed = React.useRef({ q: '', at: 0 })
  const sheet = React.useRef<HTMLDivElement>(null)
  const c = selectClasses({ width, inset, className })
  const withSearch = search ?? items.length >= SEARCH_FROM
  const chosen = items.find((i) => i.value === value)

  // Opening starts on the current value, the way a native select does; the
  // query never survives a close.
  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) setHighlight(value)
    else setQuery('')
  }

  /**
   * Letter type-ahead for the lists that carry no search box. cmdk's own
   * filtering needs an input to read; a native `<select>` needs none, and the
   * keyboard parity rule is about what the operator can do, not about which
   * library does it.
   */
  function onTypeAhead(e: React.KeyboardEvent) {
    if (withSearch) return
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return
    const now = Date.now()
    const q =
      (now - typed.current.at < TYPEAHEAD_MS ? typed.current.q : '') +
      e.key.toLowerCase()
    typed.current = { q, at: now }
    const hit = items.find(
      (i) => !i.disabled && i.label.toLowerCase().startsWith(q),
    )
    if (!hit) return
    e.preventDefault()
    setHighlight(hit.value)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        className={c.trigger}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {chosen ? (
            (chosen.render ?? chosen.label)
          ) : (
            <span className="truncate text-graphite">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className="size-3 shrink-0 text-graphite"
          strokeWidth={2}
        />
      </PopoverTrigger>
      {name === undefined ? null : (
        <input type="hidden" name={name} value={value} />
      )}
      <PopoverContent
        asChild
        align="start"
        sideOffset={4}
        className={c.sheet}
        onOpenAutoFocus={(e) => {
          // With a search box the input is the first tabbable thing in the
          // sheet and Radix's focus scope finds it. Without one there is no
          // tabbable candidate at all — cmdk rows are divs — so say plainly
          // where focus goes rather than leaning on the scope's fallback:
          // the cmdk root is the element its ↑↓/↵ handler sits on.
          if (withSearch) return
          e.preventDefault()
          sheet.current?.focus()
        }}
      >
        <CommandPrimitive
          ref={sheet}
          tabIndex={-1}
          label={ariaLabel ?? placeholder}
          value={highlight}
          onValueChange={setHighlight}
          onKeyDown={onTypeAhead}
          loop
        >
          {withSearch ? (
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule px-2.5">
              <span aria-hidden className="mono text-micro text-primary">
                ›
              </span>
              <CommandPrimitive.Input
                value={query}
                onValueChange={setQuery}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite"
              />
            </div>
          ) : null}
          <CommandPrimitive.List className="min-h-0 flex-1 scroll-py-1 overflow-x-hidden overflow-y-auto p-1">
            <CommandPrimitive.Empty className="px-2.5 py-4 text-label text-graphite">
              {emptyLabel}
            </CommandPrimitive.Empty>
            {items.map((item) => (
              <CommandPrimitive.Item
                key={item.value}
                value={item.value}
                keywords={[item.label, item.keywords ?? '']}
                disabled={item.disabled ?? false}
                onSelect={() => {
                  onChange(item.value)
                  setOpen(false)
                  setQuery('')
                }}
                className={cn(c.item, item.value === value && 'font-medium')}
              >
                {item.depth ? (
                  <span
                    aria-hidden
                    className="shrink-0"
                    style={{ width: item.depth * 12 }}
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate">
                  {item.render ?? item.label}
                </span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  )
}
