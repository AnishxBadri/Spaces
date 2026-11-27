import type { ReactNode } from 'react'
import { icon } from '../icons'
import type { IconComponent } from '../icons'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '#/lib/utils'

/**
 * A list's `Filter`: the toolbar button reading how many filters are on
 * (`Filter 1`), and the panel it opens, one row per facet. A facet is a
 * label, an optional picker the list draws (a record, a member) and chips
 * with counts; a chip is pressed to turn it on and again to turn it off.
 * The panel's foot holds `Clear` and what the filters leave (`96 of 214`).
 * Knows nothing of what is listed: the rows, the counts and what pressing
 * does are the list's.
 */

/** One chip in a facet. */
export type FilterChipOption = {
  readonly id: string
  readonly label: string
  /** The rows it leaves once it alone is on in its facet; null while read. */
  readonly count: number | null
  readonly icon?: IconComponent | undefined
  /** A mark before the label, as `Text not read`'s crimson square. */
  readonly mark?: ReactNode
}

/** One row of the panel. */
export type FilterFacetRow = {
  readonly id: string
  readonly label: string
  /** A picker the list draws before the chips: a record, a member. */
  readonly picker?: ReactNode
  readonly chips: ReadonlyArray<FilterChipOption>
}

const grouped = (n: number) => n.toLocaleString('en-US')

export function FilterControl({
  facets,
  on,
  onToggle,
  onClear,
  active,
  count,
  open,
  onOpenChange,
}: {
  facets: ReadonlyArray<FilterFacetRow>
  /** The chips that are on, by facet id. */
  on: Readonly<Record<string, ReadonlyArray<string>>>
  onToggle: (facet: string, chip: string) => void
  onClear: () => void
  /** How many filters are on, pickers included: the button's `1`. */
  active: number
  /** The foot's `96 of 214`; null while it is read. */
  count: { readonly shown: number; readonly total: number } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-tool="filter"
          className="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium text-foreground transition-colors duration-100 ease-out-quart hover:bg-bone data-[state=open]:bg-bone"
        >
          <icon.filter aria-hidden className="size-4" />
          Filter
          {active > 0 ? (
            <span className="tabular mono text-micro font-normal">
              {active}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-127 max-w-(--radix-popover-content-available-width) p-0"
      >
        <FilterPanel
          facets={facets}
          on={on}
          onToggle={onToggle}
          onClear={onClear}
          count={count}
        />
      </PopoverContent>
    </Popover>
  )
}

/** The panel's body: the facet rows, then the foot. */
export function FilterPanel({
  facets,
  on,
  onToggle,
  onClear,
  count,
}: {
  facets: ReadonlyArray<FilterFacetRow>
  on: Readonly<Record<string, ReadonlyArray<string>>>
  onToggle: (facet: string, chip: string) => void
  onClear: () => void
  count: { readonly shown: number; readonly total: number } | null
}) {
  return (
    <div data-filter-panel className="flex flex-col">
      <div className="flex flex-col pt-2.5 pb-1.5">
        {facets.map((facet) => (
          <div
            key={facet.id}
            role="group"
            aria-label={facet.label}
            data-filter-facet={facet.id}
            className="flex min-h-11 items-start gap-0 px-4 py-2"
          >
            <span className="flex h-7 w-24 shrink-0 items-center text-label text-graphite">
              {facet.label}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {facet.picker}
              {facet.chips.map((chip) => (
                <FilterChipButton
                  key={chip.id}
                  chip={chip}
                  pressed={(on[facet.id] ?? []).includes(chip.id)}
                  onPress={() => onToggle(facet.id, chip.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-ledger-row shrink-0 items-center justify-between border-t border-rule bg-bone px-4">
        <button
          type="button"
          onClick={onClear}
          className="focus-ring rounded-md text-label text-graphite hover:text-foreground"
        >
          Clear
        </button>
        {count === null ? null : (
          <span
            data-filter-count
            className="tabular mono text-micro text-graphite"
          >
            {grouped(count.shown)} of {grouped(count.total)}
          </span>
        )}
      </div>
    </div>
  )
}

function FilterChipButton({
  chip,
  pressed,
  onPress,
}: {
  chip: FilterChipOption
  pressed: boolean
  onPress: () => void
}) {
  const Icon = chip.icon
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-filter-chip={chip.id}
      onClick={onPress}
      className={cn(
        'focus-ring flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-label transition-colors duration-100 ease-out-quart',
        pressed
          ? 'border-hairline bg-hairline font-medium text-paper'
          : 'border-rule text-foreground hover:bg-bone',
      )}
    >
      {chip.mark}
      {Icon === undefined ? null : (
        <Icon aria-hidden className="size-3.5 shrink-0" />
      )}
      {chip.label}
      {chip.count === null ? null : (
        <span
          className={cn(
            'tabular mono text-micro font-normal',
            pressed ? 'text-paper' : 'text-graphite',
          )}
        >
          {grouped(chip.count)}
        </span>
      )}
    </button>
  )
}
