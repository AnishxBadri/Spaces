import { icon } from '../icons'
import type { IconComponent } from '../icons'

/**
 * The filters that are on, as a row of chips under a list's tab bar: each
 * with a × that turns it off, then `Clear`. Shown only while a filter is
 * on; the list supplies the words and what removing does.
 */

/** One filter that is on. */
export type AppliedFilter = {
  /** Unique in the row: `from:email`. */
  readonly key: string
  /** As the chip reads: `From email`, `Under Flent`. */
  readonly label: string
  readonly icon?: IconComponent | undefined
  readonly onRemove: () => void
}

export function FilterChips({
  filters,
  onClear,
}: {
  filters: ReadonlyArray<AppliedFilter>
  onClear: () => void
}) {
  if (filters.length === 0) return null
  return (
    <div
      role="group"
      aria-label="Filters on"
      data-filter-chips
      className="flex min-h-ledger-row shrink-0 flex-wrap items-center gap-2 border-b border-rule px-(--inset) py-1.5"
    >
      {filters.map((f) => {
        const Icon = f.icon
        return (
          <span
            key={f.key}
            data-applied-filter={f.key}
            className="flex h-6 items-center gap-1.5 rounded-md border border-hairline bg-bone pr-0.5 pl-2 text-label text-foreground"
          >
            {Icon === undefined ? null : (
              <Icon aria-hidden className="size-3.5 shrink-0" />
            )}
            {f.label}
            <button
              type="button"
              aria-label={`Remove ${f.label}`}
              onClick={f.onRemove}
              className="focus-ring flex size-5 items-center justify-center rounded-md text-graphite hover:bg-paper hover:text-foreground"
            >
              <icon.close aria-hidden className="size-3.5" />
            </button>
          </span>
        )
      })}
      <button
        type="button"
        onClick={onClear}
        className="focus-ring rounded-md pl-1 text-label text-graphite hover:text-foreground"
      >
        Clear
      </button>
    </div>
  )
}
