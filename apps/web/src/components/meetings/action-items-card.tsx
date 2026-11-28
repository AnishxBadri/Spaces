import { useState } from 'react'
import { toast } from 'sonner'
import { formatDay } from '@spaces/core/format'
import { Button } from '#/components/ui/button'
import { acceptSuggestion, rejectSuggestion } from '#/lib/server-fns'
import type { MeetingSuggestion } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { SheetCard } from './sheet-card'

/** A task the meeting proposed: a pine square, the item, its due day, Add task and Skip. */
function ActionItem({
  s,
  today,
  last,
  onDecided,
}: {
  s: MeetingSuggestion
  today: string
  last: boolean
  onDecided: () => void
}) {
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null)
  async function decide(verb: 'accept' | 'reject') {
    setPending(verb)
    try {
      if (verb === 'accept') await acceptSuggestion({ data: { id: s.id } })
      else await rejectSuggestion({ data: { id: s.id } })
      onDecided()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not decide it')
      setPending(null)
    }
  }
  return (
    <li
      data-action-item={s.id}
      className={cn(
        'flex h-11 items-center gap-3 px-(--inset)',
        !last && 'border-b border-rule',
      )}
    >
      <span aria-hidden className="size-2 shrink-0 bg-primary" />
      <span className="min-w-0 flex-1 truncate text-ui text-foreground">
        {s.summary}
      </span>
      <span className="w-8 shrink-0 text-right mono text-micro text-graphite">
        {s.due === null ? null : formatDay(s.due, today)}
      </span>
      <Button
        variant="outline"
        size="sm"
        pending={pending === 'accept'}
        disabled={pending !== null}
        onClick={() => void decide('accept')}
      >
        Add task
      </Button>
      <Button
        variant="ghost"
        size="sm"
        pending={pending === 'reject'}
        disabled={pending !== null}
        onClick={() => void decide('reject')}
      >
        Skip
      </Button>
    </li>
  )
}

/**
 * `Action items n`: the tasks a shared write-up proposed, each decided
 * here. An accepted one becomes the write-up author's task.
 */
export function ActionItemsCard({
  items,
  today,
  onDecided,
}: {
  items: ReadonlyArray<MeetingSuggestion>
  today: string
  onDecided: () => void
}) {
  if (items.length === 0) return null
  return (
    <SheetCard label="Action items" count={items.length}>
      <ol>
        {items.map((s, i) => (
          <ActionItem
            key={s.id}
            s={s}
            today={today}
            last={i === items.length - 1}
            onDecided={onDecided}
          />
        ))}
      </ol>
    </SheetCard>
  )
}
