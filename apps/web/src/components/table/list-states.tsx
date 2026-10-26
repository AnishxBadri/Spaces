import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'

/**
 * What a record table's body draws when it has no rows to show: the query
 * still in flight, the query failed, or a filter that matched nothing. Each
 * is one row under the column head, pinned to the left of the sideways
 * scroller so it never parks off-screen on a wide grid.
 */

const ROW =
  'sticky left-0 flex h-ledger-row w-full items-center gap-3 border-b border-rule px-3 text-ui'

/** `Loading companies`, beside the Twinkle. */
export function ListLoadingRow({ plural }: { plural: string }) {
  return (
    <div data-list-state="loading" role="status" className={ROW}>
      <Twinkle />
      <span className="text-graphite">Loading {plural.toLowerCase()}</span>
    </div>
  )
}

/** The list query failed: say so, and offer it again. */
export function ListErrorRow({
  plural,
  onRetry,
}: {
  plural: string
  onRetry: () => void
}) {
  return (
    <div data-list-state="error" role="alert" className={ROW}>
      <span aria-hidden className="size-2 shrink-0 bg-destructive" />
      <span className="min-w-0 flex-1 truncate">
        Could not load {plural.toLowerCase()} · the database did not answer
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

/**
 * A filter that matched nothing — the one place an absence sentence is
 * news. `onClear` drops the filter; without it the sentence stands alone.
 */
export function ListZeroRow({
  onClear,
}: {
  onClear?: (() => void) | undefined
}) {
  return (
    <div data-list-state="zero" className={ROW}>
      <span className="text-graphite">Nothing matches that filter.</span>
      {onClear === undefined ? null : (
        <button
          type="button"
          onClick={onClear}
          className="focus-ring rounded-md text-primary underline-offset-4 hover:underline"
        >
          Clear filter
        </button>
      )}
    </div>
  )
}
