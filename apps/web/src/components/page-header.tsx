import type { ReactNode } from 'react'
import {
  HeadActions,
  HeadBar,
  PIN_UNDER_HEAD_BAR,
  useHeadFold,
} from './head-fold'
import { cn } from '#/lib/utils'

/**
 * Page header. Serif title, or a sentence when the page has a state to
 * report; one mono line of what the instrument measured (above as an
 * eyebrow, or below as a readout); `[outline?] [Primary] [···]` right, all
 * 32px on the title's line, keys in their tooltips. The title sits on the
 * 12px page edge and the `···` ends 12px from the right, level with the
 * last control of the content under it; one rule under, 104px tall at
 * least, so every page's title and rule land on the same lines. Scrolled
 * past its title, it folds to `HeadBar`.
 * - `tabs` is the page's `Tabs` bar, under the rule; scrolled, it pins
 *   under the folded bar rather than riding into it. A list's count is on its
 *   All tab; a page with no tab bar puts it in the title (`HeadCount`).
 */
export function PageHeader({
  eyebrow,
  title,
  foldMeta,
  description,
  action,
  tabs,
  className,
}: {
  /** Mono caps line above the title — "Today · Wednesday · 2026-09-10". */
  eyebrow?: ReactNode
  title: ReactNode
  /** Mono beside the title once the head folds: Today's `Thu 15 Oct`. */
  foldMeta?: ReactNode
  /** Mono readout under the title — counts, last touch. Never prose. */
  description?: ReactNode
  action?: ReactNode
  /** The page's `Tabs` bar; pins under the folded bar. */
  tabs?: ReactNode
  className?: string
}) {
  const { titleRef, actionsRef, fold } = useHeadFold()
  return (
    <>
      <HeadBar fold={fold} title={title} meta={foldMeta} />
      <header
        className={cn(
          // One height on every page, the title on one line from the top:
          // moving between pages, the title and the rule never jump.
          'flex min-h-26 shrink-0 items-start justify-between gap-4 border-b border-rule pt-7 pb-4',
          PAGE_EDGE,
          className,
        )}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          {eyebrow ? (
            <div className="mono text-micro leading-3.5 tracking-[0.08em] text-graphite uppercase">
              {eyebrow}
            </div>
          ) : null}
          <h1 ref={titleRef} className="title-serif">
            {title}
          </h1>
          {description ? (
            <div className="flex flex-wrap items-baseline gap-x-5 mono text-label text-graphite">
              {description}
            </div>
          ) : null}
        </div>
        {action ? (
          <HeadActions fold={fold} slotRef={actionsRef}>
            {action}
          </HeadActions>
        ) : null}
      </header>
      {tabs ? (
        <div data-head-tabs className={cn('shrink-0', PIN_UNDER_HEAD_BAR)}>
          {tabs}
        </div>
      ) : null}
    </>
  )
}

/** The page edge: the title, and every card's content, sit 12px in. */
export const PAGE_EDGE = 'px-3'

/**
 * A page's body under its head: the 4px gutter, 4px down from the head's
 * rule, cards 4px apart. It holds `Card`s, or a list's tab bar and table.
 */
export function PageBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <div
      data-page-body
      className={cn('flex flex-col gap-1 px-1 pt-1 pb-8', className)}
    >
      {children}
    </div>
  )
}

/**
 * A content card: a 1px rule box. Rows and bands inside it inset 7px, so its
 * content lands on the page's 12px edge.
 */
export function Card({
  children,
  className,
  label,
}: {
  children: ReactNode
  className?: string | undefined
  /** Names the card when no heading inside it does. */
  label?: string | undefined
}) {
  return (
    <section
      data-card
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cn('flex flex-col card', className)}
    >
      {children}
    </section>
  )
}

/**
 * A page title with its count on the baseline — `Portfolio 12` — for a page
 * with no tab bar to carry it. A number is formatted; anything else as is.
 */
export function HeadCount({
  title,
  count,
}: {
  title: ReactNode
  count: ReactNode
}) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-3">
      {title}
      {count === null || count === undefined || count === false ? null : (
        <span
          data-head-count
          className="tabular shrink-0 mono text-label font-normal text-graphite"
        >
          {typeof count === 'number' ? count.toLocaleString('en-US') : count}
        </span>
      )}
    </span>
  )
}
