import { Link } from '@tanstack/react-router'
import { createContext, useContext } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { HeadActions, HeadBar, useHeadFold } from '#/components/head-fold'
import { EmptyRow, SectionHead } from '#/components/ledger-section'
import { Twinkle } from '#/components/twinkle'
import { Stamp } from '#/components/ui/stamp'
import type { StampProps } from '#/components/ui/stamp'
import { cn } from '#/lib/utils'

/**
 * Record page anatomy. Header: the stamp alone on its row, then the mark,
 * the serif name, its suffix and badges with the actions bottom-aligned at
 * the right, the double rule under — no readout strip; scrolled past its
 * name it folds to `HeadBar`.
 * Body: `RecordBody details=…` — the 320px details column on bone left (the
 * property grid as label–value rows, then the relationship sections), the
 * tab head over one view right. Every part is markup only; the pages keep
 * their data and handlers.
 */

/**
 * One cell of the readout strip: a number or a date, never a word.
 * - `muted` is graphite: a zero, or nothing to measure. A bare `—` reads
 *   graphite without asking.
 * - `bad` is crimson, for a value past its threshold.
 * - `warn` is amber, for a nonzero value worth a look but not yet bad.
 */
export type RecordReadout = {
  label: ReactNode
  value: ReactNode
  tone?: 'muted' | 'bad' | 'warn' | undefined
  /**
   * A figure rather than a number — a bar with its labels: the cell takes
   * twice the width and draws `value` as given.
   */
  figure?: boolean | undefined
  /** The list the number was counted from; the cell becomes its link. */
  to?: string | undefined
  /** Search params for `to`, when the count is of a filtered list. */
  search?: Record<string, string> | undefined
}

/**
 * What follows a record's name on its line: a parent path in mono micro
 * (`Spaces / Fintech`), or a person's role in sans (`Partner · Flent`).
 */
export type RecordSuffix = { path: ReactNode } | { role: ReactNode }

export function RecordHeader({
  stamp,
  suffix,
  actions,
  mark,
  name,
  nameField,
  archived = false,
  badges,
}: {
  /** The page's one stamp, alone on the row above the name. */
  stamp: StampProps
  suffix?: RecordSuffix | undefined
  actions?: ReactNode
  mark?: ReactNode
  name: ReactNode
  /** Rename in place: drawn where the title is; the folded bar keeps `name`. */
  nameField?: ReactNode
  /** An archived record: the name and the double rule go graphite. */
  archived?: boolean
  badges?: ReactNode
  /** Accepted and not drawn: a record's readouts live in its Overview tab. */
  readouts?: Array<RecordReadout>
}) {
  const { titleRef, actionsRef, fold } = useHeadFold()
  return (
    <>
      <HeadBar fold={fold} title={name} mark={mark} />
      <header
        className={cn(
          'flex shrink-0 flex-col gap-3 px-6 pt-5 pb-4 double-rule',
          archived && 'double-rule-archived',
        )}
      >
        <div data-stamp-row className="flex">
          <Stamp {...stamp} />
        </div>
        <div className="flex items-end justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            {mark}
            <h1
              ref={titleRef}
              className={cn(
                'min-w-0 truncate title-serif',
                nameField !== undefined && 'flex-1',
                archived && 'text-graphite',
              )}
            >
              {nameField ?? name}
            </h1>
            {suffix === undefined ? null : (
              <span
                data-suffix
                className={cn(
                  'min-w-0 shrink truncate text-graphite',
                  'path' in suffix ? 'mono text-micro' : 'text-ui',
                )}
              >
                {'path' in suffix ? suffix.path : suffix.role}
              </span>
            )}
            {badges}
          </div>
          {actions ? (
            <HeadActions fold={fold} slotRef={actionsRef}>
              {actions}
            </HeadActions>
          ) : null}
        </div>
      </header>
    </>
  )
}

/**
 * A record head while its page loads, for a route's `pendingComponent`: the
 * stamp, the mark twinkling, the title graphite, and no verbs.
 */
export function RecordHeadPending({ kind }: { kind: string }) {
  return (
    <div className="flex min-h-full flex-col">
      <header
        data-record-pending
        className="flex shrink-0 flex-col gap-3 px-6 pt-5 pb-4 double-rule"
      >
        <div data-stamp-row className="flex">
          <Stamp kind={kind} />
        </div>
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="flex size-7 shrink-0 items-center justify-center border border-hairline bg-paper">
            <Twinkle label={`Loading the ${kind.toLowerCase()}`} />
          </span>
          <h1 className="min-w-0 truncate title-serif text-graphite">
            Loading…
          </h1>
        </div>
      </header>
    </div>
  )
}

/**
 * The readout strip: equal cells on rules under a hairline, the
 * value in mono over a sentence-case label. The record head draws it, so do
 * Cmd-K's preview of a record and Today's head.
 * - A cell with `to` is a link to the list it counted; hover inks the label.
 * - `pane` sets the values a size down, so three fit the preview pane's
 *   width without clipping a day and its age.
 */
export function ReadoutStrip({
  readouts,
  size = 'page',
  className,
}: {
  readouts: ReadonlyArray<RecordReadout>
  size?: 'page' | 'pane' | undefined
  className?: string | undefined
}) {
  return (
    <div
      data-readouts
      className={cn(
        'flex h-16 overflow-x-auto border-t border-hairline',
        className,
      )}
    >
      {readouts.map((r, i) => {
        const cls = cn(
          'flex min-w-28 basis-0 flex-col justify-center gap-0.5 border-r border-rule first:pl-0 last:border-r-0',
          size === 'pane' ? 'px-3' : 'px-4',
          r.figure ? 'max-w-110 flex-2' : 'max-w-55 flex-1',
        )
        const inner = (
          <>
            {r.figure ? (
              <div className="flex h-6.5 min-w-0 items-end">{r.value}</div>
            ) : (
              <span
                className={cn(
                  'truncate mono leading-6.5',
                  size === 'pane' ? 'text-title' : 'text-page',
                  r.tone === 'bad'
                    ? 'text-destructive'
                    : r.tone === 'warn'
                      ? 'text-warning'
                      : r.tone === 'muted' || r.value === '—'
                        ? 'text-graphite'
                        : 'text-foreground',
                )}
              >
                {r.value}
              </span>
            )}
            <span
              className={cn(
                'truncate text-label text-graphite',
                r.to !== undefined && 'group-hover:text-foreground',
              )}
            >
              {r.label}
            </span>
          </>
        )
        return r.to === undefined ? (
          <div key={i} className={cls}>
            {inner}
          </div>
        ) : (
          <Link
            key={i}
            to={r.to}
            // Spread: a cell with no filter passes no `search` at all.
            {...(r.search ? { search: r.search } : {})}
            className={cn(cls, 'group focus-ring-inset')}
          >
            {inner}
          </Link>
        )
      })}
    </div>
  )
}

/**
 * A counted cell: a zero reads graphite, and a tone colours only a nonzero
 * count.
 */
export type CountCell = {
  label: ReactNode
  value: number
  tone?: 'bad' | 'warn' | undefined
  to?: string | undefined
  search?: Record<string, string> | undefined
}

export function countReadout({
  value,
  tone,
  ...cell
}: CountCell): RecordReadout {
  const shown = value === 0 ? 'muted' : tone
  return {
    ...cell,
    value: String(value),
    ...(shown === undefined ? {} : { tone: shown }),
  }
}

/**
 * A head at preview size, for Cmd-K's pane: the stamp and crumb, then the
 * name in serif. A `record` head closes on the double rule, as the record
 * page's does; anything else on a hairline.
 */
export function PreviewHead({
  record = false,
  stamp,
  crumb,
  mark,
  name,
  children,
}: {
  record?: boolean
  stamp: string
  crumb: string
  mark?: ReactNode
  name: string
  /** Under the name: a record's readout strip. */
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 px-5 pt-4',
        record ? 'double-rule' : 'border-b border-hairline',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Stamp kind={stamp} />
        {crumb ? (
          <span
            data-crumb
            className="min-w-0 truncate mono text-micro tracking-[0.08em] text-graphite uppercase"
          >
            {crumb}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        {mark}
        <h2 className="min-w-0 truncate font-serif text-page font-semibold">
          {name || 'Untitled'}
        </h2>
      </div>
      {children ?? <div className="h-1" />}
    </div>
  )
}

/**
 * Body. With `details` it is the tabbed record: the 320px details
 * column on bone left, sticking under the folded bar on wide screens, and
 * `children` — the tab head over its view — taking the rest, edge to edge.
 * - Without it, the older shape the term and holding pages keep: the page
 *   left, a `rail` right on bone.
 */
export function RecordBody({
  children,
  rail,
  details,
}: {
  children: ReactNode
  rail?: ReactNode
  details?: ReactNode
}) {
  if (details !== undefined) {
    return (
      <div
        data-record-body="details"
        className="flex min-h-0 flex-1 flex-col xl:flex-row"
      >
        <aside
          aria-label="Details"
          className="flex w-full shrink-0 flex-col border-b border-hairline bg-bone xl:sticky xl:top-10 xl:max-h-[calc(100dvh-2.5rem)] xl:w-80 xl:overflow-y-auto xl:border-r xl:border-b-0"
        >
          {details}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col pb-8">{children}</div>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-8 px-8 pt-6 pb-8">
        {children}
      </div>
      {rail ? (
        <aside className="flex w-full shrink-0 flex-col border-t border-hairline bg-bone xl:sticky xl:top-10 xl:max-h-[calc(100dvh-2.5rem)] xl:w-90 xl:overflow-y-auto xl:border-t-0 xl:border-l">
          {rail}
        </aside>
      ) : null}
    </div>
  )
}

/** A section of the page: the bone head band (sentence-case title, mono
 *  meta beside it), then its content on paper. */
export function RecordSection({
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
    <section className={cn('flex flex-col', className)}>
      <SectionHead title={label} count={meta} />
      {children}
    </section>
  )
}

/**
 * The property grid at the head of the details column: a box on a rule, one
 * label–value row per attribute with a rule between — a bone label cell in
 * sans graphite beside a paper value cell. Cells are `PropertyCell`s
 * (RailField renders one).
 */
export function PropertyGrid({ children }: { children: ReactNode }) {
  return (
    <div data-property-grid className="flex flex-col border border-rule">
      {children}
    </div>
  )
}

/**
 * A rejected write reads crimson in place for two seconds, then returns to
 * rest. Three phases, because the
 * hold and the leaving are different things: `rest` draws nothing, `hold` is
 * the crimson, `leaving` is the 120ms fade off it.
 */
export type RejectPhase = 'rest' | 'hold' | 'leaving'

/** How long the cell reads crimson, the fade out included. */
export const REJECT_HOLD_MS = 2000
/** The fade off it — the tail of the hold, not time added to it. */
export const REJECT_LEAVE_MS = 120

/**
 * The crimson the cell wears while a write is being refused. It is a pane, not
 * a border on the cell itself: a border would move the cell's content by a
 * pixel, and the No-Shift Rule has no exceptions. It arrives at full strength
 * — the snap-back is instant, there is nothing to animate into — and leaves on
 * opacity alone, so the Compositor Rule holds and `prefers-reduced-motion`
 * takes the fade to nothing while the two-second hold, which is a state and
 * not a motion, still happens.
 */
export function rejectPaneClass(phase: RejectPhase): string {
  return cn(
    'pointer-events-none absolute inset-0 border border-destructive transition-opacity duration-[120ms] ease-out-quart',
    phase === 'leaving' ? 'opacity-0' : 'opacity-100',
  )
}

export function PropertyCell({
  label,
  children,
  below,
  className,
  reject = 'rest',
}: {
  label: ReactNode
  children: ReactNode
  /** An error or hint line under the value. */
  below?: ReactNode
  className?: string
  /** The cell's rejected-write phase; `RailField` owns the clock. */
  reject?: RejectPhase | undefined
}) {
  return (
    <div
      className={cn(
        'relative flex min-w-0 items-stretch border-b border-rule last:border-b-0',
        className,
      )}
    >
      {reject === 'rest' ? null : (
        <span aria-hidden className={rejectPaneClass(reject)} />
      )}
      {/* The label cell runs the row's full height, so a value that grows
          (wrapped chips) keeps its label on the first line; a long label
          wraps rather than truncates. */}
      <div
        data-property-label
        className="flex w-28 shrink-0 items-start gap-1 border-r border-rule bg-bone px-2.5 py-2 text-label break-words text-graphite"
      >
        {label}
      </div>
      {/* The field editor is its own 32px box with an 8px inset, so the
          cell adds 2px: its text lands on the label's 10px. */}
      <div
        data-property-value
        className="flex min-h-8 min-w-0 flex-1 flex-col justify-center bg-paper px-0.5 text-ui"
      >
        {children}
        {below ? <div className="px-2 pb-1">{below}</div> : null}
      </div>
    </div>
  )
}

/** The name of the empty `RailSection` a composer row sits in, if any. */
const EmptySection = createContext<string | null>(null)

/**
 * A rail section on bone: sentence-case title at the title step, mono
 * meta right, rows on rules. The rail is already bone, so no band.
 * - `empty`: the section holds nothing, so it is one `Name +` row — the
 *   head goes and the section's `DetailsAddRow` draws as its `EmptyRow`.
 */
export function RailSection({
  label,
  meta,
  empty = false,
  children,
  className,
}: {
  label: string
  meta?: ReactNode
  empty?: boolean | undefined
  children: ReactNode
  className?: string
}) {
  if (empty)
    return (
      <section
        aria-label={label}
        className={cn(
          // The row's own 12px inset lands its name on the titles' 24px.
          'flex flex-col border-b border-hairline px-3 last:border-b-0',
          className,
        )}
      >
        <EmptySection.Provider value={label}>{children}</EmptySection.Provider>
      </section>
    )
  return (
    <section
      className={cn(
        'flex flex-col border-b border-hairline px-6 py-4 last:border-b-0',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h2 className="min-w-0 truncate text-title font-medium text-foreground">
          {label}
        </h2>
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

/** A 36px readout row in the rail: sans graphite label left, mono value
 *  right. */
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
      <span className="text-label text-graphite">{label}</span>
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

/**
 * The composer row a details section ends on: `+ Add …` in graphite. A
 * plain button that spreads its props, so a dialog trigger can hand it its
 * own. In an empty section it is that section's `EmptyRow` instead.
 */
export function DetailsAddRow({
  children,
  className,
  ...props
}: ComponentProps<'button'>) {
  const empty = useContext(EmptySection)
  if (empty !== null) return <EmptyRow {...props} name={empty} />
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'focus-ring flex h-row w-full min-w-0 items-center gap-2.5 border-t border-rule text-left text-ui text-graphite transition-colors hover:text-foreground',
        className,
      )}
    >
      <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
        +
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

/**
 * The stage stepper: one 8px segment per live stage, pine up to and
 * including the current one, hairline outline after. Labels: first, the
 * current with its days and the stage's median (`Diligence 11d · med 9`),
 * last.
 */
export function StageStepper({
  stages,
  currentId,
  days,
  median,
}: {
  stages: Array<{ id: string; label: string }>
  currentId: string | null
  days?: number | null
  /** Median days deals spend in this stage, when there is one. */
  median?: number | null
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
      <div className="flex justify-between gap-3 mono text-field">
        <span className="text-graphite">{first?.label}</span>
        <span className="font-medium text-foreground">
          {current
            ? days === null || days === undefined
              ? current.label
              : median === null || median === undefined
                ? `${current.label} ${days}d`
                : `${current.label} ${days}d · med ${median}`
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
          ? /* Optical sizing, not a type step: initials in a 16px square.
               The named steps start at 10px (field) and overflow it. */
            // eslint-disable-next-line instrument/vocabulary
            'size-4 text-[0.5rem] leading-[0.625rem]'
          : size === 'lg'
            ? 'size-7 text-label leading-4'
            : 'size-[1.375rem] text-field',
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
 * A record's picture in place of its mark, cropped square at the mark's
 * size. `src` is only ever the blob store's URL for a stored picture, never
 * a remote address.
 */
export function PictureMark({
  src,
  size,
  className,
}: {
  src: string
  size: number
  className?: string
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      draggable={false}
      style={{ width: size, height: size }}
      className={cn(
        'shrink-0 rounded-none border border-hairline bg-paper object-cover',
        className,
      )}
    />
  )
}

/** The picture when the record has one, else its own mark. */
export function RecordMark({
  picture,
  size,
  fallback,
}: {
  picture: string | null | undefined
  size: number
  fallback: ReactNode
}) {
  return picture ? <PictureMark src={picture} size={size} /> : fallback
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
