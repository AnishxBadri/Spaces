import { Layers } from '#/components/icons'
import { Select } from '#/components/ui/select'
import type { SelectItem } from '#/components/ui/select'
import type { SpaceOption } from './feed-words'

/** The picker's value for no space chosen. */
const ALL = 'all'

/**
 * Headlines' space filter: `All spaces`, then each space a feed is tagged
 * to, by path.
 * - `bar`, after the tabs from `md` up: the Layers mark and the picker, bare
 *   on the tab bar, no box, the way the canvas draws it. The `label` carries
 *   the clicks on the mark to the trigger.
 * - `line`, in the narrow head's mono line: the space's name alone is the
 *   trigger, with no chevron, as the narrow board draws it.
 * - A chosen space the list does not hold (a link from a space no feed is
 *   tagged to) is still named on the trigger.
 */
export function SpaceFilter({
  value,
  spaces,
  pathOf,
  onChange,
  variant = 'bar',
}: {
  /** The chosen space's id; null is every space. */
  value: string | null
  spaces: ReadonlyArray<SpaceOption>
  pathOf: ReadonlyMap<string, string>
  onChange: (spaceId: string | null) => void
  variant?: 'bar' | 'line' | undefined
}) {
  const listed =
    value === null || spaces.some((s) => s.id === value)
      ? spaces
      : [...spaces, { id: value, path: pathOf.get(value) ?? 'A space' }]
  const items: Array<SelectItem<string>> = [
    { value: ALL, label: 'All spaces' },
    ...listed.map((s) => ({ value: s.id, label: s.path })),
  ]
  const picker = {
    value: value ?? ALL,
    onChange: (next: string) => onChange(next === ALL ? null : next),
    items,
    width: 'content' as const,
    searchPlaceholder: 'Search spaces…',
    emptyLabel: 'No space matches.',
  }

  if (variant === 'line') {
    const chosen = items.find((i) => i.value === picker.value)?.label
    return (
      <span data-space-filter-line className="flex min-w-0">
        <Select
          {...picker}
          aria-label={`Space: ${chosen ?? 'All spaces'}`}
          // The line's mono at its size; the select's box, pad and chevron
          // dropped, so the name reads as the rest of the line does.
          className="h-auto w-auto max-w-44 gap-0 rounded-none border-0 bg-transparent px-0 mono text-micro text-graphite hover:text-foreground data-[state=open]:text-foreground [&>svg]:hidden"
        />
      </span>
    )
  }

  return (
    <label
      data-space-filter
      className="flex h-9 min-w-0 items-center gap-1.5 pl-2 text-ui"
    >
      <Layers aria-hidden className="size-4 shrink-0" />
      <Select
        {...picker}
        aria-label="Space"
        className="h-9 w-auto max-w-80 border-0 bg-transparent px-0 pr-2"
      />
    </label>
  )
}
