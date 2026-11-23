import type { ReactNode } from 'react'
import { Email } from '#/components/icons'

/**
 * The head of a pane on the Email page: the email glyph at 20px, the serif
 * subject, a mono context line, then the pane's own acts. A window's head
 * in place, on paper and without a dialog behind it.
 */
export function PaneHead({
  title,
  context,
  children,
}: {
  title: ReactNode
  /** Mono, right of the title: the thread's size, or who reads it. */
  context?: ReactNode
  /** The pane's acts, last on the line. */
  children?: ReactNode
}) {
  return (
    <div
      data-pane-head
      className="flex h-12 shrink-0 items-center gap-2.5 border-b border-rule bg-paper px-4"
    >
      <Email
        data-window-mark
        aria-hidden
        className="size-5 shrink-0 text-graphite"
      />
      <h2 className="min-w-0 truncate font-serif text-lg leading-5.5 font-semibold">
        {title}
      </h2>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {context === undefined || context === null ? null : (
          <span className="mr-1.5 mono text-micro text-graphite">
            {context}
          </span>
        )}
        {children}
      </span>
    </div>
  )
}
