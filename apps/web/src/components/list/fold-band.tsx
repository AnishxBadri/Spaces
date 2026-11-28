import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from '../icons'
import { cn } from '#/lib/utils'

/**
 * A group's band that folds: a chevron, the group's mark, its name in
 * medium and its count, on bone. Pressing it hides or shows the rows it
 * heads; the list holds which bands are folded.
 * - `row` draws it as a 40px row on paper, the fold that ends a list, its
 *   count in ink, rather than a band over a group.
 * - `end` is mono at the far end: what the fold reaches (`to 14 Dec`).
 */
export function FoldBand({
  label,
  count,
  mark,
  open,
  onOpenChange,
  controls,
  row = false,
  end,
}: {
  label: string
  count: number
  /** The group's 16px mark: a record's kind icon. */
  mark?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The id of the rows it folds. */
  controls: string
  row?: boolean | undefined
  end?: ReactNode
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <h3 className="contents">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        data-fold-band
        onClick={() => onOpenChange(!open)}
        className={cn(
          'focus-ring-inset flex w-full shrink-0 items-center gap-2 border-b border-rule px-(--inset) text-left text-ui transition-colors duration-100 ease-out-quart',
          row
            ? 'h-ledger-row bg-paper hover:bg-row-hover'
            : 'h-8 bg-bone hover:bg-paper',
        )}
      >
        <Chevron aria-hidden className="size-4 shrink-0" />
        {mark}
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span
          className={cn(
            'tabular shrink-0 mono text-micro',
            row ? 'text-foreground' : 'text-graphite',
          )}
        >
          {count.toLocaleString('en-US')}
        </span>
        {end === undefined || end === null ? null : (
          <span className="ml-auto shrink-0 mono text-micro text-graphite">
            {end}
          </span>
        )}
      </button>
    </h3>
  )
}
