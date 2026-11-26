import * as React from 'react'

import { icon } from '#/components/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils.ts'

/**
 * The one search field, for every list's toolbar and the Email page: a
 * magnifier, the placeholder, and an end slot that holds the `/` hint at rest
 * and a real clear cell once there is text.
 * - `Esc` in the field clears it; the key is printed nowhere.
 * - `slash` binds `/` to focus the field and shows the hint.
 * - `fold` draws a 28px icon button while the field is empty and closed; it
 *   opens the field, and `Esc` folds it again.
 * - `onClose`, for a field the caller shows on demand: `Esc`, or leaving the
 *   field empty, asks the caller to hide it.
 */
export function SearchField({
  value,
  onValueChange,
  placeholder,
  label,
  slash = false,
  fold = false,
  autoFocus = false,
  onClose,
  className,
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder: string
  /** The field's accessible name, and the folded button's. */
  label: string
  slash?: boolean
  fold?: boolean
  autoFocus?: boolean
  onClose?: () => void
  /** The field's width, from the caller. */
  className?: string
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const [opened, setOpened] = React.useState(value !== '')
  useHotkey(slash ? '/' : undefined, () => input.current?.focus())

  if (fold && !opened && value === '')
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => setOpened(true)}
        className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-md border border-rule bg-paper text-foreground transition-colors duration-100 ease-out-quart hover:bg-bone"
      >
        <icon.search aria-hidden className="size-4" />
      </button>
    )

  return (
    <div
      data-search-field
      className={cn(
        'group/search focus-ring-within flex h-7 shrink-0 items-center rounded-md border border-rule bg-paper transition-colors duration-100 ease-out-quart focus-within:border-hairline',
        className,
      )}
    >
      <icon.search
        aria-hidden
        className="ml-2 size-4 shrink-0 text-graphite group-focus-within/search:text-foreground"
      />
      <input
        ref={input}
        type="search"
        value={value}
        autoFocus={autoFocus || fold}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          if (value === '' && !fold && onClose === undefined) return
          e.preventDefault()
          onValueChange('')
          if (fold) setOpened(false)
          onClose?.()
        }}
        onBlur={(e) => {
          // Focus moving to the clear cell is still inside the field.
          if (e.currentTarget.parentElement?.contains(e.relatedTarget)) return
          if (value === '') onClose?.()
        }}
        placeholder={placeholder}
        aria-label={label}
        aria-keyshortcuts={slash ? '/' : undefined}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-ui outline-none placeholder:text-graphite"
      />
      {value !== '' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Clear"
              data-search-clear
              onClick={() => {
                onValueChange('')
                input.current?.focus()
              }}
              className="flex h-full w-6.75 shrink-0 items-center justify-center border-l border-rule text-foreground outline-none hover:border-hairline hover:bg-hairline hover:text-paper focus-visible:border-hairline focus-visible:bg-hairline focus-visible:text-paper"
            >
              <icon.close aria-hidden className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Clear</TooltipContent>
        </Tooltip>
      ) : slash ? (
        <span
          aria-hidden
          data-search-key
          className="mr-1.25 flex size-4 shrink-0 items-center justify-center rounded-md border border-rule mono text-field text-graphite"
        >
          /
        </span>
      ) : null}
    </div>
  )
}
