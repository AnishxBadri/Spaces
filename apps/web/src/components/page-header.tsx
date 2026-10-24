import type { ReactNode } from 'react'
import {
  HeadActions,
  HeadBar,
  PIN_UNDER_HEAD_BAR,
  useHeadFold,
} from './head-fold'
import { keyHintClasses, useButtonPending } from './ui/button'
import { cn } from '#/lib/utils'

/**
 * Page header. Serif title, or a sentence when
 * the page has a state to report; one mono line of what the instrument
 * measured (above as an eyebrow, or below as a readout); actions right,
 * each carrying its key hint inside the button. The double rule under,
 * 32px inset, 28px above — the header owns its own anatomy so every field
 * starts on the same line. Scrolled past its title, it folds to `HeadBar`.
 * - `tabs` is the page's own tab row, under the double rule; scrolled, it
 *   pins under the folded bar rather than riding into it.
 * - `count` is a list's mono count beside its title — `Companies 312`.
 */
export function PageHeader({
  eyebrow,
  title,
  count,
  description,
  action,
  tabs,
  className,
}: {
  /** Mono caps line above the title — "Today · Wednesday · 2026-09-10". */
  eyebrow?: ReactNode
  title: ReactNode
  /** Mono readout beside the title, on its baseline — a list's size, or
   *  "26 spaces · 18 nested". A number is formatted; anything else as is. */
  count?: ReactNode
  /** Mono readout under the title — counts, last touch. Never prose. */
  description?: ReactNode
  action?: ReactNode
  /** The page's tab row: underline tabs that pin under the folded bar. */
  tabs?: ReactNode
  className?: string
}) {
  const { titleRef, actionsRef, fold } = useHeadFold()
  return (
    <>
      <HeadBar fold={fold} title={title} />
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
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 ref={titleRef} className="title-serif">
              {title}
            </h1>
            {count !== undefined && count !== null && count !== false ? (
              <span
                data-head-count
                className="tabular shrink-0 mono text-label text-graphite"
              >
                {typeof count === 'number'
                  ? count.toLocaleString('en-US')
                  : count}
              </span>
            ) : null}
          </div>
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
        <div
          data-head-tabs
          className={cn(
            'flex h-10 shrink-0 items-end border-b border-rule bg-paper px-5',
            PIN_UNDER_HEAD_BAR,
          )}
        >
          {tabs}
        </div>
      ) : null}
    </>
  )
}

/**
 * A key hint inside a button — mono, never a chip. It drops with the label
 * swap while the button is pending and comes back when the action
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
