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
  variant = 'default',
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'variant'> & {
  /** What it makes, in sentence case after `New`: `company`, `note`. */
  noun: string
  /** Pine, except the bordered secondary of a tab's toolbar. */
  variant?: 'default' | 'outline' | undefined
}) {
  return (
    <Button data-new-button {...props} variant={variant} className={className}>
      <icon.new aria-hidden className="size-4" />
      New {noun}
    </Button>
  )
}

/**
 * The split create, `[+ New x | ▾]`, where creating is instant and templates
 * exist: the left half makes a blank one, the `▾` opens the templates.
 * - `templates` draws the menu around the trigger it is handed (a
 *   `TemplatePicker` takes it as its `trigger`).
 * - `secondary` is the split inside a tab's toolbar: the bordered small
 *   button, as Files' `Upload`, since pine belongs to the page head.
 */
export function SplitNewButton({
  noun,
  onNew,
  shortcut,
  templates,
  variant = 'primary',
  className,
}: {
  noun: string
  onNew: () => void
  /** The key that makes a blank one, for the left half's tooltip. */
  shortcut?: string | undefined
  templates: (trigger: ReactElement) => ReactNode
  variant?: 'primary' | 'secondary' | undefined
  className?: string | undefined
}) {
  const secondary = variant === 'secondary'
  return (
    <span
      data-split-new={variant}
      // The bordered halves share one border between them; pine's sit a
      // pixel apart.
      className={cn(
        'inline-flex',
        secondary ? '-space-x-px' : 'gap-px',
        className,
      )}
    >
      <NewButton
        noun={noun}
        shortcut={shortcut}
        onClick={onNew}
        variant={secondary ? 'outline' : 'default'}
        size={secondary ? 'sm' : 'default'}
        className="rounded-r-none"
      />
      {templates(
        <Button
          size={secondary ? 'sm' : 'icon'}
          variant={secondary ? 'outline' : 'default'}
          aria-label={`New ${noun} from a template`}
          title="From a template"
          data-split-new-menu
          className="w-7 rounded-l-none"
        >
          <ChevronDown aria-hidden className="size-4" />
        </Button>,
      )}
    </span>
  )
}
