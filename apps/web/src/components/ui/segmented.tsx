import type { ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'

/**
 * The segmented control: a bounded set of mutually exclusive choices in one
 * 28px bone-deep box, the chosen segment raised on paper. The nested switch
 * under a tab bar, a window's kind, a filter whose segments carry counts.
 *
 * A radiogroup, not a row of toggle buttons: exactly one is chosen at all
 * times, which is what `role="radio"` + `aria-checked` says and what
 * `aria-pressed` does not. The reticle frames the whole box, not a segment.
 *
 * Generic over the option ids so a caller with a union type — a note kind,
 * an interaction kind — gets that union back in `onChange` instead of a
 * bare string it would have to narrow or assert.
 */
export type SegmentedOption<T extends string> = {
  id: T
  /** The words, or a mark that `name` then names. */
  label: ReactNode
  /** The segment's accessible name when `label` is a mark. */
  name?: string | undefined
  /** Mono count after the label; none is printed at 0. */
  count?: number | undefined
  /** A tooltip on the segment — the key the page listens for, a mark's name. */
  tip?: string | undefined
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  className,
}: {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (id: T) => void
  disabled?: boolean | undefined
  /** Names the group for screen readers when no visible label sits beside it. */
  label?: string | undefined
  className?: string | undefined
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'focus-ring-within flex h-7 w-fit items-stretch gap-0.5 rounded-md border border-rule bg-bone-deep p-0.5',
        className,
      )}
    >
      {options.map((o) => {
        const on = value === o.id
        const segment = (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            {...(o.name !== undefined ? { 'aria-label': o.name } : {})}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              'flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-label whitespace-nowrap transition-colors duration-150 ease-out-quart outline-none disabled:opacity-50',
              on
                ? 'border-rule bg-paper text-foreground'
                : 'border-transparent text-graphite hover:bg-bone-deep hover:text-foreground',
            )}
          >
            {o.label}
            {o.count !== undefined && o.count > 0 ? (
              <span data-segment-count className="tabular mono text-micro">
                {o.count}
              </span>
            ) : null}
          </button>
        )
        return o.tip === undefined ? (
          segment
        ) : (
          <Tooltip key={o.id}>
            <TooltipTrigger asChild>{segment}</TooltipTrigger>
            <TooltipContent>{o.tip}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
