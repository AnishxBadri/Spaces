import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * P2 — Ledger section (Instrument, 2026-09-10). Caps label + mono count
 * left, one mono link right, hairline under the head. Rows are 36px on
 * rules; the last row may be a composer. The section is a list, so the
 * rows are `<li>`s and the caller decides what a row is (a link, a task
 * with its checkbox, a composer trigger).
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
      <div className="flex items-baseline justify-between border-b border-hairline pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="label-caps text-foreground">{label}</h2>
          {count ? (
            <span className="mono text-micro text-graphite">{count}</span>
          ) : null}
        </div>
        {link ? (
          <div className="mono text-micro text-graphite">{link}</div>
        ) : null}
      </div>
      <ol>{children}</ol>
    </section>
  )
}

/** A 36px row on a rule. `last` drops the rule so a composer can follow. */
export function LedgerRow({
  children,
  className,
  last,
}: {
  children: ReactNode
  className?: string
  last?: boolean | undefined
}) {
  return (
    <li
      className={cn(
        'flex h-row items-center gap-3',
        !last && 'border-b border-rule',
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
