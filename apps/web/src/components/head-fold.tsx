import { useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { cn } from '#/lib/utils'

/**
 * The sticky head: once a page or record head's title scrolls out, the head
 * folds to a 40px bar — a record's mark, the title in serif at the title
 * step, an optional mono meta, and the head's own actions at 26px.
 * `PageHeader` and `RecordHeader` own it.
 * - Nothing below moves: the bar hangs from a zero-height sticky anchor and
 *   enters on transform and opacity only.
 * - The actions are never rendered twice. The head's own element turns
 *   `fixed` into the bar's right lane while its slot keeps the measured size,
 *   so every hotkey and every effect inside it stays bound once.
 */

/**
 * Pins an element directly under the folded 40px bar (and the mobile top
 * bar): a record's tab head, a page head's tabs. One line for every page,
 * so nothing hangs across the bar's rule.
 */
export const PIN_UNDER_HEAD_BAR = 'sticky top-22 z-sticky md:top-10'

/** The title folds once it passes under this line: the mobile top bar. */
const FOLD_LINE_PX = 48

export type HeadFold =
  { folded: false } | { folded: true; width: number; height: number }

const OPEN: HeadFold = { folded: false }

/** Watch the head's title; measure the actions slot at the moment it folds. */
export function useHeadFold() {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const [fold, setFold] = useState<HeadFold>(OPEN)

  useEffect(() => {
    const title = titleRef.current
    if (!title || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1)
        if (!entry) return
        const line = entry.rootBounds?.top ?? FOLD_LINE_PX
        if (entry.isIntersecting || entry.boundingClientRect.top >= line) {
          setFold(OPEN)
          return
        }
        setFold((prev) => {
          if (prev.folded) return prev
          const slot = actionsRef.current?.getBoundingClientRect()
          return {
            folded: true,
            width: slot?.width ?? 0,
            height: slot?.height ?? 0,
          }
        })
      },
      { rootMargin: `-${FOLD_LINE_PX}px 0px 0px 0px` },
    )
    observer.observe(title)
    return () => observer.disconnect()
  }, [])

  return { titleRef, actionsRef, fold }
}

/**
 * The 40px bar. Always mounted, decorative to assistive tech (the head's h1
 * and its real actions stay the accessible ones), on `z-sticky`, isolated.
 * Enter 180ms, exit 120ms; reduced motion just shows or hides it.
 * - `mark` is a record's head mark, drawn at 16px in a hairline box. It is a
 *   second copy of the head's, so it is `inert`: nothing in it takes focus
 *   or a pointer.
 */
export function HeadBar({
  fold,
  title,
  mark,
  meta,
}: {
  fold: HeadFold
  title: ReactNode
  mark?: ReactNode
  /** Mono beside the title, on its baseline. */
  meta?: ReactNode
}) {
  return (
    <div
      data-head-anchor
      className="pointer-events-none sticky top-12 z-sticky h-0 md:top-0"
    >
      <div
        aria-hidden
        data-head-bar
        data-folded={fold.folded}
        className="absolute inset-x-0 top-0 isolate flex h-10 -translate-y-full items-center gap-3 border-b border-hairline bg-paper px-4 opacity-0 transition-[transform,opacity] duration-[120ms] ease-out-quart data-[folded=true]:pointer-events-auto data-[folded=true]:translate-y-0 data-[folded=true]:opacity-100 data-[folded=true]:duration-[180ms] motion-reduce:transition-none"
        style={
          fold.folded
            ? { paddingRight: `calc(2rem + ${fold.width}px)` }
            : undefined
        }
      >
        {mark === undefined || mark === null ? null : (
          <span
            inert
            data-head-bar-mark
            className="pointer-events-none flex size-4 shrink-0 items-center justify-center overflow-hidden border border-hairline"
          >
            <span className="flex shrink-0 scale-50">{mark}</span>
          </span>
        )}
        <span className="flex min-w-0 items-baseline gap-2.5">
          <span className="min-w-0 truncate font-serif text-title font-semibold">
            {title}
          </span>
          {meta === undefined || meta === null ? null : (
            <span className="shrink-0 mono text-micro text-graphite">
              {meta}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * The head's actions, rendered once. Folded, the element is lifted into the
 * bar's right lane and its slot holds the size it had, so the head below
 * keeps its height and nothing after it moves.
 */
export function HeadActions({
  fold,
  slotRef,
  children,
}: {
  fold: HeadFold
  slotRef: Ref<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <div
      ref={slotRef}
      data-head-actions-slot
      className="shrink-0"
      style={
        fold.folded ? { width: fold.width, height: fold.height } : undefined
      }
    >
      <div
        data-head-actions
        data-folded={fold.folded}
        className={cn(
          'flex items-center gap-2',
          'data-[folded=true]:fixed data-[folded=true]:top-12 data-[folded=true]:right-4 data-[folded=true]:z-sticky data-[folded=true]:h-10 md:data-[folded=true]:top-0',
          // Folded, every action steps down to 26px to sit inside the bar.
          'data-[folded=true]:[&_[data-size=icon]]:w-6.5 data-[folded=true]:[&_[data-slot=button]]:h-6.5',
          'data-[folded=true]:animate-in data-[folded=true]:duration-[180ms] data-[folded=true]:fade-in-0 motion-reduce:animate-none',
        )}
      >
        {children}
      </div>
    </div>
  )
}
