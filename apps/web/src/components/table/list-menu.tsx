import { MoreMenu } from '#/components/ui/more-menu'

/** One verb in a list head's `···`. */
export type ListVerb = {
  label: string
  /** Runs once the menu has closed, so a window it opens keeps its focus. */
  onSelect: () => void
}

/**
 * The list head's `···`: verbs over the whole list as its view shows it —
 * Enrich… first. Each opens a window, so it runs after the menu lets go.
 */
export function ListMenu({
  label,
  verbs,
}: {
  /** What the list is called — "Companies". */
  label: string
  verbs: ReadonlyArray<ListVerb>
}) {
  return (
    <MoreMenu
      variant="head"
      label={label}
      items={verbs.map((v) => ({
        label: v.label,
        onSelect: v.onSelect,
        opens: true,
      }))}
    />
  )
}
