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
  forceMenu = false,
}: {
  /** What the list is called — "Companies". */
  label: string
  verbs: ReadonlyArray<ListVerb>
  /** Keep a lone verb in the `···` rather than draw it as a button. */
  forceMenu?: boolean | undefined
}) {
  return (
    <MoreMenu
      variant="head"
      label={label}
      forceMenu={forceMenu}
      items={verbs.map((v) => ({
        label: v.label,
        onSelect: v.onSelect,
        opens: true,
      }))}
    />
  )
}
