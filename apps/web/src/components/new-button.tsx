import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { ChevronDown, icon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

/**
 * Every create: `+ New x` in pine. Spreads its props onto the `Button`, so a
 * dialog trigger can hand it its own.
 */
export function NewButton({
  noun,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'variant'> & {
  /** What it makes, in sentence case after `New`: `company`, `note`. */
  noun: string
}) {
  return (
    <Button data-new-button {...props} className={className}>
      <icon.new aria-hidden className="size-4" strokeWidth={2} />
      New {noun}
    </Button>
  )
}

/**
 * The split create, `[+ New x | ▾]`, where creating is instant and templates
 * exist: the left half makes a blank one, the `▾` opens the templates.
 * - `templates` draws the menu around the trigger it is handed (a
 *   `TemplatePicker` takes it as its `trigger`).
 */
export function SplitNewButton({
  noun,
  onNew,
  shortcut,
  templates,
  className,
}: {
  noun: string
  onNew: () => void
  /** The key that makes a blank one, for the left half's tooltip. */
  shortcut?: string | undefined
  templates: (trigger: ReactElement) => ReactNode
  className?: string | undefined
}) {
  return (
    <span data-split-new className={cn('inline-flex gap-px', className)}>
      <NewButton
        noun={noun}
        shortcut={shortcut}
        onClick={onNew}
        className="rounded-r-none"
      />
      {templates(
        <Button
          size="icon"
          aria-label={`New ${noun} from a template`}
          title="From a template"
          data-split-new-menu
          className="w-7 rounded-l-none"
        >
          <ChevronDown aria-hidden className="size-3.5" strokeWidth={2} />
        </Button>,
      )}
    </span>
  )
}
