import { useRef } from 'react'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'

/** One verb in a list head's `···`. */
export type ListVerb = {
  label: string
  /** Runs once the menu has closed, so a window it opens keeps its focus. */
  onSelect: () => void
}

/**
 * The list head's `···`: verbs over the whole list as its view shows it —
 * Enrich… first. A verb that opens a window runs after the menu's focus trap
 * lets go, or the window's focus is pulled back to the trigger.
 */
export function ListMenu({
  label,
  verbs,
}: {
  /** What the list is called — "Companies". */
  label: string
  verbs: ReadonlyArray<ListVerb>
}) {
  const afterClose = useRef<(() => void) | null>(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`More for ${label}`}>
          <span aria-hidden className="mono text-ui">
            ···
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        onCloseAutoFocus={(e) => {
          const run = afterClose.current
          if (run === null) return
          e.preventDefault()
          afterClose.current = null
          run()
        }}
      >
        {verbs.map((v) => (
          <DropdownMenuItem
            key={v.label}
            onSelect={() => {
              afterClose.current = v.onSelect
            }}
          >
            {v.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
