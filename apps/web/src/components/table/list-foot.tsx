import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * Grouped, never compact — `Intl.NumberFormat` compact notation prints
 * differently under Node and Chrome and takes hydration down with it. The
 * locale is named so the two agree on the separator.
 */
const grouped = (n: number) => n.toLocaleString('en-US')

/** What a list that loads a page at a time hands its foot. */
export type ListFootPage = {
  /** Another page exists after the ones loaded. */
  hasMore: boolean
  /** A page is in flight. */
  loading: boolean
  /** Rows per page — the number the link offers to add. */
  step: number
  onLoadMore: () => void
}

/**
 * A fixed-pane list's permanent foot: `50 of 312 · Load 50 more` on
 * the left, a surface's own end on the right. It holds the card's bottom
 * while the rows scroll above it.
 * - `count` absent, the left lane is empty: the list is drawing a state
 *   (loading, failed, nothing matched) in place of its rows.
 * - `words` stands in for `shown of total` where the tab's own count is
 *   the news (`241 meetings`); Load more follows it the same way.
 * - `folder` rules it in hairline, as the folder body it closes; otherwise
 *   in rule, as a card.
 */
export function ListFoot({
  count,
  words,
  page,
  end,
  folder = false,
  className,
}: {
  count?: { shown: number; total: number } | undefined
  /** Mono words in the count's place: `241 meetings`. */
  words?: string | undefined
  page?: ListFootPage | undefined
  end?: ReactNode
  folder?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <div
      data-table-foot
      className={cn(
        'flex h-8 shrink-0 items-center justify-between gap-3 border-t px-2.75',
        folder ? 'border-hairline' : 'border-rule',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {count === undefined ? null : (
          <span className="tabular field-label text-graphite">
            {grouped(count.shown)} of {grouped(count.total)}
          </span>
        )}
        {words === undefined ? null : (
          <span className="tabular field-label text-graphite">{words}</span>
        )}
        {(count !== undefined || words !== undefined) &&
        page?.hasMore === true ? (
          <>
            <span aria-hidden className="field-label text-graphite">
              ·
            </span>
            <button
              type="button"
              onClick={page.onLoadMore}
              disabled={page.loading}
              className="focus-ring rounded-md text-label text-foreground underline-offset-4 hover:underline disabled:text-graphite disabled:no-underline"
            >
              {page.loading ? 'Loading…' : `Load ${grouped(page.step)} more`}
            </button>
          </>
        ) : null}
      </span>
      {end}
    </div>
  )
}
