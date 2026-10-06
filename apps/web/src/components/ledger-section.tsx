import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * The section head band (the Separation Rule): a hairline opens the section,
 * then 44px of bone with a rule under. Title in sentence case at the title
 * step, a mono count beside it, the head's one action right. `LedgerSection`,
 * `RecordSection` and a group inside a settings section all draw this band.
 */
export function SectionHead({
  title,
  count,
  action,
  as: Heading = 'h2',
  className,
}: {
  title: ReactNode
  /** Mono readout beside the title — "5 · 2 overdue". */
  count?: ReactNode
  /** The head's one action, mono, right. */
  action?: ReactNode
  /** `h3` for a group inside a section that already has a heading. */
  as?: 'h2' | 'h3' | undefined
  className?: string | undefined
}) {
  return (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center justify-between gap-4 border-t border-b border-t-hairline border-b-rule bg-bone px-3',
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <Heading className="min-w-0 truncate text-title font-medium text-foreground">
          {title}
        </Heading>
        {count ? (
          <span className="shrink-0 mono text-micro text-graphite">
            {count}
          </span>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-baseline gap-3 mono text-micro text-graphite">
          {action}
        </div>
      ) : null}
    </div>
  )
}

/**
 * P2 — Ledger section. The bone head band (title + mono count left, one
 * mono link right), then 40px rows on rules; the last row may be a
 * composer. The section is a list, so the rows are `<li>`s and the caller
 * decides what a row is (a link, a task with its checkbox, a composer
 * trigger).
 */
export function LedgerSection({
  label,
  count,
  link,
  children,
  className,
}: {
  label: ReactNode
  /** Mono readout after the label — "5 · 2 overdue". */
  count?: ReactNode
  /** The one way out of the section, mono, right. */
  link?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col', className)}>
      <SectionHead title={label} count={count} action={link} />
      <ol>{children}</ol>
    </section>
  )
}

/**
 * The class a row takes when a composer on this page just created it
 * (DESIGN.md §5, Micro-interactions; SPA-53) — a bone wash that fades out
 * over 250ms. Exported so a row that is not a `LedgerRow` (a table row, a
 * card) can land the same way, and so the contract is testable without a DOM.
 *
 * `wash` comes from `useBornRows().washes(id)`, never from a timestamp: the
 * wash is for a row this session added, not for a row that happens to be
 * young. The utility itself lives in styles.css.
 */
export function rowWashClass(wash: boolean | undefined): string {
  return wash === true ? 'row-wash' : ''
}

/**
 * A 40px ledger row on a rule, inset to the head band's title. The primary
 * is body (14) in ink, with at most one graphite meta line. `last` drops the
 * rule so a composer can follow.
 */
export function LedgerRow({
  children,
  className,
  last,
  wash,
}: {
  children: ReactNode
  className?: string
  last?: boolean | undefined
  /** Born through a composer on this page — lands on the bone wash. */
  wash?: boolean | undefined
}) {
  return (
    <li
      className={cn(
        'flex h-ledger-row items-center gap-3 px-3',
        !last && 'border-b border-rule',
        rowWashClass(wash),
        className,
      )}
    >
      {children}
    </li>
  )
}

/** The fixed right lane every ledger row ends on: 64px, mono, right. */
export function LedgerFigure({
  children,
  tone,
  wide,
}: {
  children: ReactNode
  tone?: 'bad' | 'muted' | undefined
  /** 80px instead of 64 — for `09-08 · −2d` style figures. */
  wide?: boolean | undefined
}) {
  return (
    <span
      className={cn(
        'shrink-0 numeric text-micro',
        wide ? 'w-20' : 'w-16',
        tone === 'bad'
          ? 'text-destructive'
          : tone === 'muted'
            ? 'text-graphite'
            : 'text-foreground',
      )}
    >
      {children}
    </span>
  )
}

/**
 * P3 — reference bar. A number is never shown alone when a median exists:
 * the ink fill is the value, the graphite tick is the median, the track is
 * the scale (the longest value in the section fills it). 1-bit, no colour.
 */
export function ReferenceBar({
  value,
  median,
  scale,
  width = 120,
}: {
  value: number
  median: number | null
  /** The value that fills the whole track. */
  scale: number
  width?: number
}) {
  const w = Math.max(1, Math.min(width, Math.round((value / scale) * width)))
  const tick =
    median === null ? null : Math.round(Math.min(1, median / scale) * width)
  return (
    <svg
      width={width}
      height="8"
      viewBox={`0 0 ${width} 8`}
      className="shrink-0"
      aria-hidden
    >
      <rect x="0" y="3" width={width} height="2" fill="var(--rule)" />
      <rect x="0" y="3" width={w} height="2" fill="var(--hairline)" />
      {tick !== null ? (
        <rect x={tick} y="0" width="1" height="8" fill="var(--graphite)" />
      ) : null}
    </svg>
  )
}
