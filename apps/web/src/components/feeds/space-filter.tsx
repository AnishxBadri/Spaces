import { Layers } from '#/components/icons'
import { Select } from '#/components/ui/select'
import type { SpaceOption } from './feed-words'

/** The picker's value for no space chosen. */
const ALL = 'all'

/**
 * Headlines' space filter, after the tabs: `All spaces ▾`, then each space
 * a feed is tagged to, by path. Bare on the tab bar, no box, the way the
 * canvas draws it.
 * - A chosen space the list does not hold (a link from a space no feed is
 *   tagged to) is still named on the trigger.
 * - The `label` carries the clicks on the mark to the trigger.
 */
export function SpaceFilter({
  value,
  spaces,
  pathOf,
  onChange,
}: {
  /** The chosen space's id; null is every space. */
  value: string | null
  spaces: ReadonlyArray<SpaceOption>
  pathOf: ReadonlyMap<string, string>
  onChange: (spaceId: string | null) => void
}) {
  const listed =
    value === null || spaces.some((s) => s.id === value)
      ? spaces
      : [...spaces, { id: value, path: pathOf.get(value) ?? 'A space' }]
  return (
    <label
      data-space-filter
      className="flex h-9 min-w-0 items-center gap-1.5 pl-2 text-ui"
    >
      <Layers aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <Select
        aria-label="Space"
        value={value ?? ALL}
        onChange={(next) => onChange(next === ALL ? null : next)}
        items={[
          { value: ALL, label: 'All spaces' },
          ...listed.map((s) => ({ value: s.id, label: s.path })),
        ]}
        width="content"
        searchPlaceholder="Search spaces…"
        emptyLabel="No space matches."
        className="h-9 w-auto max-w-80 border-0 bg-transparent px-0 pr-2"
      />
    </label>
  )
}
