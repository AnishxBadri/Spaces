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
 * 32px, keys in their tooltips. The double rule under, 32px inset, 28px
 * above — the header owns its own anatomy so every field starts on the same
 * line. Scrolled past its title, it folds to `HeadBar`.
 * - `tabs` is the page's `Tabs` bar, under the double rule; scrolled, it pins
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
          'flex shrink-0 items-end justify-between gap-4 px-8 pt-7 pb-4 double-rule',
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
