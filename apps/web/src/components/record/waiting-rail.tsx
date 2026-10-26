import { Link } from '@tanstack/react-router'
import { RailGroup, RailGroupRow } from '#/components/record/record-parts'
import type { WaitingSuggestion } from '#/lib/server-fns'

/**
 * The record rail's Waiting group: how many suggestions are open on this
 * record, the newest few by title (`✦ Founders from Apollo +3`), each a
 * link into `/review` scoped to the record, and `n more in Review ›` when
 * more wait than are listed.
 *
 * **A pointer, never a verb.** Accept and reject live in Review only, so
 * bulk accept has one path rather than two to keep in step. Do not add an
 * action here — link to Review instead.
 *
 * Nothing waiting → no group, no zero.
 */
export function WaitingRail({
  entityId,
  waiting,
}: {
  entityId: string
  waiting: { count: number; items: ReadonlyArray<WaitingSuggestion> }
}) {
  if (waiting.count === 0) return null
  const more = waiting.count - waiting.items.length
  return (
    <RailGroup label="Waiting" count={waiting.count}>
      {waiting.items.map((s) => (
        <RailGroupRow key={s.id}>
          <Link
            to="/review"
            search={{ record: entityId, lane: 'suggestions' }}
            className="group/link focus-ring flex min-w-0 flex-1 items-center gap-2"
          >
            <span aria-hidden className="shrink-0 text-primary">
              ✦
            </span>
            <span className="min-w-0 flex-1 truncate group-hover/link:underline">
              {s.title}
            </span>
          </Link>
        </RailGroupRow>
      ))}
      {more > 0 ? (
        <RailGroupRow>
          <Link
            to="/review"
            search={{ record: entityId, lane: 'suggestions' }}
            className="focus-ring min-w-0 flex-1 truncate text-label text-graphite hover:text-foreground"
          >
            {more} more in Review ›
          </Link>
        </RailGroupRow>
      ) : null}
    </RailGroup>
  )
}
