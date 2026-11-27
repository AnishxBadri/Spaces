import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from '../icons'

/**
 * A group's band that folds: a chevron, the group's mark, its name in
 * medium and its count, on bone. Pressing it hides or shows the rows it
 * heads; the list holds which bands are folded.
 */
export function FoldBand({
  label,
  count,
  mark,
  open,
  onOpenChange,
  controls,
}: {
  label: string
  count: number
  /** The group's 16px mark: a record's kind icon. */
  mark?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The id of the rows it folds. */
  controls: string
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
        className="focus-ring-inset flex h-8 w-full shrink-0 items-center gap-2 border-b border-rule bg-bone px-(--inset) text-left text-ui transition-colors duration-100 ease-out-quart hover:bg-paper"
      >
        <Chevron aria-hidden className="size-4 shrink-0" />
        {mark}
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="tabular shrink-0 mono text-micro text-graphite">
          {count.toLocaleString('en-US')}
        </span>
      </button>
    </h3>
  )
}
