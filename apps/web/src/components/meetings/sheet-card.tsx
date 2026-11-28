import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * One card of a meeting sheet's body: paper in a rule box on the bone, its
 * rows on the card's 16px line. The head is the label in mono caps, its
 * count in ink, and a way out at its right end.
 */
export function SheetCard({
  label,
  count,
  lead,
  action,
  headClassName,
  className,
  children,
}: {
  label: string
  count?: number | undefined
  /** A mark before the label: the recorder that wrote the write-up. */
  lead?: ReactNode
  action?: ReactNode
  headClassName?: string | undefined
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <section
      aria-label={label}
      data-sheet-card
      className={cn('flex shrink-0 flex-col card [--inset:1rem]', className)}
    >
      <div
        data-card-head
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 border-b border-rule px-4',
          headClassName,
        )}
      >
        {lead}
        <h3 className="label-caps text-graphite">{label}</h3>
        {count === undefined ? null : (
          <span className="mono text-micro text-foreground">{count}</span>
        )}
        {action === undefined ? null : (
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {action}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

/** A card head's way out: sans, ink, `Rentwise ›`. */
export const CARD_LINK =
  'focus-ring shrink-0 text-label text-foreground hover:underline'
