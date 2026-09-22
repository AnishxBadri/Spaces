import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { keyHintClasses, useButtonPending } from './ui/button'
import { cn } from '#/lib/utils'

/**
 * P1 — Page header (Instrument, 2026-09-10). Serif title, or a sentence when
 * the page has a state to report; one mono line of what the instrument
 * measured (above as an eyebrow, or below as a readout); actions right,
 * each carrying its key hint inside the button. Hairline under, 32px
 * inset, 28px above — the header owns its own anatomy so every field
 * starts on the same line.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  /** Mono caps line above the title — "Today · Wednesday · 2026-09-10". */
  eyebrow?: ReactNode
  title: ReactNode
  /** Mono readout under the title — counts, last touch. Never prose. */
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-end justify-between gap-4 border-b border-hairline px-8 pt-7 pb-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? (
          <div className="mono text-micro leading-3.5 tracking-[0.08em] text-graphite uppercase">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="title-serif">{title}</h1>
        {description ? (
          <div className="flex flex-wrap items-baseline gap-x-5 mono text-label text-graphite">
            {description}
          </div>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      ) : null}
    </header>
  )
}

/**
 * A key hint inside a button — mono, never a chip. It drops with the label
 * swap while the button is pending (SPA-53) and comes back when the action
 * re-arms; it stays in the DOM throughout, so the width it holds never moves
 * anything next to it, and leaves the accessibility tree with the paint.
 */
export function KeyHint({ children }: { children: ReactNode }) {
  const pending = useButtonPending()
  return (
    <kbd
      className={keyHintClasses(pending)}
      {...(pending ? { 'aria-hidden': true } : {})}
    >
      {children}
    </kbd>
  )
}

export type ReadoutTone = 'bad' | 'warn'

export type ReadoutCell = {
  label: ReactNode
  value: number | string
  /** Colour only when the number is nonzero and means trouble. */
  tone?: ReadoutTone
  to?: string
  /**
   * Search params for `to` (SPA-124). A counter whose destination is a
   * *filtered* list — Today's Unfiled cell pointing at
   * `/documents?filed=unfiled` — has to carry the filter or the link lands on
   * a different number than the one it printed. Dropping the link instead
   * would make that cell the only dead one in the strip.
   */
  search?: Record<string, string>
}

/**
 * Readout strip: cells split by rules, hairline under. Label is caps mono
 * 10px; value is mono 20/500. A zero reads in graphite — nothing to see —
 * and colour appears only when the value is nonzero and bad.
 */
export function ReadoutStrip({
  cells,
  className,
}: {
  cells: Array<ReadoutCell>
  className?: string
}) {
  return (
    <div
      className={cn('flex h-16 shrink-0 border-b border-hairline', className)}
    >
      {cells.map((cell, i) => {
        const zero = cell.value === 0 || cell.value === '0'
        const colour = zero
          ? 'text-graphite'
          : cell.tone === 'bad'
            ? 'text-destructive'
            : cell.tone === 'warn'
              ? 'text-warning'
              : 'text-foreground'
        const inner = (
          <>
            <span className="field-label text-graphite">{cell.label}</span>
            <span className={cn('mono text-xl leading-6 font-medium', colour)}>
              {cell.value}
            </span>
          </>
        )
        const cls = cn(
          'flex min-w-0 flex-1 flex-col justify-center gap-0.5 border-r border-rule px-6 last:border-r-0',
          i === 0 && 'pl-8',
        )
        return cell.to ? (
          <Link
            key={i}
            to={cell.to}
            // Spread rather than `search={cell.search}`: under
            // `exactOptionalPropertyTypes` an omitted field is not the same
            // claim as an explicit `undefined`, and a cell with no filter
            // must pass no `search` at all.
            {...(cell.search ? { search: cell.search } : {})}
            className={cn(
              cls,
              'focus-ring-inset transition-colors hover:bg-bone',
            )}
          >
            {inner}
          </Link>
        ) : (
          <div key={i} className={cls}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}
