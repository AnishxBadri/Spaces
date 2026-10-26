import type { ComponentProps, ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * What a section head carries at its right edge: its count in mono ink, or
 * a `Segmented` whose segments carry the counts — never both (the
 * Separation Rule).
 */
type HeadEnd =
  | {
      /** Mono readout at the band's right — "5 · 2 overdue". */
      count?: ReactNode
      switch?: never
    }
  | {
      /** A `Segmented` at the band's right, its segments counted. */
      switch: ReactNode
      count?: never
    }

/**
 * The section head band (the Separation Rule): a hairline opens the section,
 * then 44px of bone with a rule under. Title in sentence case at the title
 * step left; the head's one action, then the count or the switch, right.
 * `LedgerSection`, `RecordSection` and a group inside a settings section
 * all draw this band.
 */
export function SectionHead({
  title,
  count,
  switch: segmented,
  action,
  as: Heading = 'h2',
  className,
}: {
  title: ReactNode
  /** The head's one action, mono, right. */
  action?: ReactNode
  /** `h3` for a group inside a section that already has a heading. */
  as?: 'h2' | 'h3' | undefined
  className?: string | undefined
} & HeadEnd) {
  return (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center justify-between gap-4 border-t border-b border-t-hairline border-b-rule bg-bone px-3',
        className,
      )}
    >
      <Heading className="min-w-0 truncate text-title font-medium text-foreground">
        {title}
      </Heading>
      {action || count || segmented ? (
        <div className="flex shrink-0 items-center gap-3">
          {action ? (
            <div className="flex items-baseline gap-3 mono text-micro text-graphite">
              {action}
            </div>
          ) : null}
          {segmented ?? null}
          {count ? (
            <span
              data-section-count
              className="tabular mono text-micro text-foreground"
            >
              {count}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A mono caps label in ink on paper, a hairline under it — the head of a
 * ledger that is the page's one list (the market map), where a bone band
 * would be a second head under the page's own. 28px; lane heads ride right
 * as `children`.
 */
export function LabelHead({
  label,
  children,
  className,
}: {
  label: ReactNode
  /** Sans lane heads, aligned with the rows' fixed lanes. */
  children?: ReactNode
  className?: string | undefined
}) {
  return (
    <div
      className={cn(
        'flex h-7 shrink-0 items-center gap-2.5 border-b border-hairline bg-paper px-3',
        className,
      )}
    >
      <h2 className="min-w-0 flex-1 truncate label-caps text-foreground">
        {label}
      </h2>
      {children}
    </div>
  )
}

/**
 * A group head inside a pane: 28px of bone on a rule, its label in mono
 * caps graphite, an optional way out at the right (`All interactions ›`).
 * A page section opens on a `SectionHead`; a group inside one opens here.
 */
export function Band({
  label,
  link,
  className,
}: {
  label: ReactNode
  /** Sans graphite, right — a link to where the group's full list lives. */
  link?: ReactNode
  className?: string | undefined
}) {
  return (
    <div
      data-band
      className={cn(
        'flex h-7 shrink-0 items-center justify-between gap-3 border-b border-rule bg-bone px-3',
        className,
      )}
    >
      <h3 className="min-w-0 truncate label-caps text-graphite">{label}</h3>
      {link ? (
        <div className="flex shrink-0 items-center text-label text-graphite">
          {link}
        </div>
      ) : null}
    </div>
  )
}

/**
 * An empty section: one `Name +` row on bone, the name in graphite and the
 * whole row the way in — no sentence, no composer, no 0. Rows stack with a
 * rule between them. A plain button that spreads its props, so a dialog
 * trigger can hand it its own.
 */
export function EmptyRow({
  name,
  onAdd,
  className,
  ...props
}: {
  /** The section's own name — `Tasks`, `Spaces`. */
  name: string
  onAdd?: (() => void) | undefined
} & Omit<ComponentProps<'button'>, 'children' | 'name'>) {
  return (
    <button
      type="button"
      data-empty-row
      {...(onAdd !== undefined ? { onClick: onAdd } : {})}
      {...props}
      className={cn(
        'focus-ring-inset flex h-row w-full min-w-0 items-center justify-between gap-3 border-b border-rule bg-bone px-3 text-left text-ui text-graphite transition-colors duration-150 ease-out-quart last:border-b-0 hover:text-foreground',
        className,
      )}
    >
      <span className="min-w-0 truncate">{name}</span>
      <span aria-hidden className="shrink-0 text-title">
        +
      </span>
    </button>
  )
}

/**
 * The foot of a list cut short: `25 more` on a rule, which unfolds the
 * rest in place.
 */
export function FoldRow({
  hidden,
  detail,
  onShow,
  className,
}: {
  /** How many rows the fold holds back. */
  hidden: number
  /** What the held-back rows are, after a `·`: `Seed 3, Pre-seed 2`. */
  detail?: string | undefined
  onShow: () => void
  className?: string | undefined
}) {
  return (
    <button
      type="button"
      data-fold-row
      onClick={onShow}
      className={cn(
        'focus-ring-inset flex h-ledger-row w-full items-center border-t border-rule px-3 text-left text-label text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground',
        className,
      )}
    >
      {hidden} more
      {detail ? ` · ${detail}` : null}
    </button>
  )
}

/**
 * Ledger section. The bone head band (title left; one mono link, then the
 * mono count, right), then 40px rows on rules; the last row may be a
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
  /** Mono readout at the head's right — "5 · 2 overdue". */
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
 * The class a row takes when a composer on this page just created it — a
 * bone wash that fades out over 250ms. Exported so a row that is not a
 * `LedgerRow` (a table row, a card) can land the same way, and so the
 * contract is testable without a DOM.
 *
 * `wash` comes from `useBornRows().washes(id)`, never from a timestamp: the
 * wash is for a row this session added, not for a row that happens to be
 * young. The utility itself lives in the stylesheet.
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
 * Reference bar. A number is never shown alone when a median exists:
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
