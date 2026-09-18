import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * P7 — Record page anatomy (Instrument, 2026-09-10). Header: breadcrumb,
 * actions, serif name + badge, a readout strip of the numbers that matter.
 * Body left: property grid (three columns, hairline top and bottom, rules
 * inside), then the sections — notes, ledger, files. Rail right on bone:
 * stage stepper, readouts, people. Every part is markup only; the pages
 * keep their data and handlers.
 */

export type RecordReadout = {
  label: ReactNode
  value: ReactNode
  /** Names are sans; everything measured is mono (the default). */
  kind?: 'mono' | 'text' | undefined
  tone?: 'muted' | 'bad' | undefined
}

export function RecordHeader({
  crumb,
  actions,
  mark,
  name,
  badges,
  readouts,
}: {
  crumb: ReactNode
  actions?: ReactNode
  mark?: ReactNode
  name: ReactNode
  badges?: ReactNode
  readouts?: Array<RecordReadout>
}) {
  return (
    <header className="flex shrink-0 flex-col gap-3.5 border-b border-hairline px-8 pt-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 truncate mono text-micro leading-[0.875rem] tracking-[0.08em] text-graphite uppercase">
          {crumb}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3.5">
        {mark}
        <h1 className="min-w-0 truncate title-serif">{name}</h1>
        {badges}
      </div>
      {readouts && readouts.length > 0 ? (
        <div className="flex h-14 overflow-x-auto">
          {readouts.map((r, i) => (
            <div
              key={i}
              className="flex shrink-0 flex-col justify-center gap-0.5 border-r border-rule px-6 first:pl-0 last:border-r-0"
            >
              <span className="label-caps text-[0.625rem] leading-3 font-normal text-graphite">
                {r.label}
              </span>
              <span
                className={cn(
                  'truncate font-medium',
                  r.kind === 'text'
                    ? 'text-title leading-[1.125rem]'
                    : 'mono text-lg leading-[1.375rem]',
                  r.tone === 'muted'
                    ? 'text-graphite'
                    : r.tone === 'bad'
                      ? 'text-destructive'
                      : 'text-foreground',
                )}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-1" />
      )}
    </header>
  )
}

/** Body: the page left, the rail right on bone. The rail never scrolls
 *  with the body on wide screens. */
export function RecordBody({
  children,
  rail,
}: {
  children: ReactNode
  rail?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-6 px-8 pt-6 pb-8">
        {children}
      </div>
      {rail ? (
        <aside className="flex w-full shrink-0 flex-col border-t border-hairline bg-bone xl:sticky xl:top-0 xl:max-h-dvh xl:w-90 xl:overflow-y-auto xl:border-t-0 xl:border-l">
          {rail}
        </aside>
      ) : null}
    </div>
  )
}

/** A section of the page: caps label left, mono meta right, optional
 *  hairline above when it follows prose. */
export function RecordSection({
  label,
  meta,
  action,
  rule,
  children,
  className,
}: {
  label: ReactNode
  meta?: ReactNode
  action?: ReactNode
  rule?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex flex-col',
        rule && 'border-t border-hairline pt-3',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-4 pb-2">
        <h2 className="label-caps text-graphite">{label}</h2>
        <div className="flex items-baseline gap-3 mono text-micro text-graphite">
          {meta}
          {action}
        </div>
      </div>
      {children}
    </section>
  )
}

/** Three columns of label + value cells; hairline top and bottom, rules
 *  inside. Cells are `PropertyCell`s (RailField renders one). */
export function PropertyGrid({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-hairline">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {children}
      </div>
      <div className="-mt-px border-t border-hairline" />
    </div>
  )
}

export function PropertyCell({
  label,
  children,
  below,
  className,
}: {
  label: ReactNode
  children: ReactNode
  /** An error or hint line under the value. */
  below?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-h-[2.125rem] flex-col justify-center border-r border-b border-rule px-3 py-1 max-md:border-r-0 md:max-xl:[&:nth-child(2n)]:border-r-0 xl:[&:nth-child(3n)]:border-r-0',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex w-24 shrink-0 items-center gap-1 label-caps text-[0.625rem] leading-3 font-normal text-graphite">
          {label}
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {below}
    </div>
  )
}

/** A rail section on bone: caps label, mono meta, rows on rules. */
export function RailSection({
  label,
  meta,
  children,
  className,
}: {
  label: ReactNode
  meta?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex flex-col border-b border-hairline px-6 py-4 last:border-b-0',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h2 className="label-caps text-graphite">{label}</h2>
        {meta ? (
          <div className="flex items-baseline gap-3 mono text-micro text-graphite">
            {meta}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** A 36px readout row in the rail: caps label left, mono value right. */
export function RailRow({
  label,
  value,
  className,
}: {
  label: ReactNode
  value: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-row items-center justify-between gap-3 border-t border-rule',
        className,
      )}
    >
      <span className="label-caps text-[0.625rem] leading-3 font-normal text-graphite">
        {label}
      </span>
      <span className="min-w-0 truncate mono text-ui font-medium">{value}</span>
    </div>
  )
}

/** A 28px list row in the rail — a person, a deal, a space. */
export function RailItem({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex h-7 items-center gap-2.5 text-ui', className)}>
      {children}
    </div>
  )
}

/** Quiet line for an empty rail section. */
export function RailEmpty({ children }: { children: ReactNode }) {
  return <p className="py-1 text-label text-graphite">{children}</p>
}

/**
 * The stage stepper: one 8px segment per live stage, pine up to and
 * including the current one, hairline outline after. Labels: first, the
 * current with its days, last.
 */
export function StageStepper({
  stages,
  currentId,
  days,
}: {
  stages: Array<{ id: string; label: string }>
  currentId: string | null
  days?: number | null
}) {
  const idx = stages.findIndex((s) => s.id === currentId)
  const first = stages.at(0)
  const last = stages.at(-1)
  const current = idx >= 0 ? stages[idx] : null
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-[3px]" aria-hidden>
        {stages.map((s, i) => (
          <span
            key={s.id}
            className={cn(
              'h-2 flex-1',
              i <= idx ? 'bg-primary' : 'border border-hairline',
            )}
          />
        ))}
      </div>
      <div className="flex justify-between gap-3 mono text-[0.625rem] leading-3">
        <span className="text-graphite">{first?.label}</span>
        <span className="font-medium text-foreground">
          {current
            ? days === null || days === undefined
              ? current.label
              : `${current.label} · ${days}d`
            : '—'}
        </span>
        <span className="text-graphite">
          {last && last !== first ? last.label : ''}
        </span>
      </div>
    </div>
  )
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.charAt(0) ?? ''
  const last = parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? '') : ''
  return (first + last).toUpperCase()
}

/** An initials mark: ink square with paper letters, or outlined for a
 *  person who is not on the team. Never a circle. */
export function InitialsMark({
  name,
  outline,
  size = 'sm',
  className,
}: {
  name: string
  outline?: boolean
  /** xs 16px (board cards), sm 22px (lists), lg 28px (record header). */
  size?: 'xs' | 'sm' | 'lg'
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center mono',
        size === 'xs'
          ? 'size-4 text-[0.5rem] leading-[0.625rem]'
          : size === 'lg'
            ? 'size-7 text-label leading-4'
            : 'size-[1.375rem] text-[0.625rem] leading-3',
        outline
          ? 'border border-hairline bg-paper text-foreground'
          : 'bg-hairline text-paper',
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  )
}

/**
 * The fallback record mark: a paper tile with a hairline edge and a 2px
 * pine checker inside — 1-bit, never under text (the Dither Rule).
 */
export function DitherMark({
  size = 28,
  className,
}: {
  size?: number
  className?: string
}) {
  const cells: Array<[number, number]> = []
  for (let y = 3; y < size - 4; y += 2) {
    for (let x = 3 + ((y / 2) % 2) * 2; x < size - 4; x += 4) {
      cells.push([x, y])
    }
  }
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', className)}
    >
      <rect
        x="0.5"
        y="0.5"
        width={size - 1}
        height={size - 1}
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <g fill="var(--primary)">
        {cells.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="2" height="2" />
        ))}
      </g>
    </svg>
  )
}
