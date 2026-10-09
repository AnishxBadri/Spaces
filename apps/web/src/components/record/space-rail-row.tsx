import { Link } from '@tanstack/react-router'
import { Layers, X } from 'lucide-react'
import { RailItem } from '#/components/record/record-parts'
import { cn } from '#/lib/utils'

/**
 * One space a record is filed in, on its details column. An archived space
 * keeps the row — filings outlive an archive — dimmed, with no untag.
 */
export function SpaceRailRow({
  space,
  onRemove,
}: {
  space: { id: string; name: string; archived: boolean }
  onRemove: () => void
}) {
  return (
    <RailItem className="group">
      <Layers className="size-3.5 shrink-0 text-graphite" strokeWidth={1.75} />
      <Link
        to="/spaces/$spaceId"
        params={{ spaceId: space.id }}
        className={cn(
          'focus-ring min-w-0 flex-1 truncate hover:underline',
          space.archived && 'text-graphite',
        )}
      >
        {space.name}
      </Link>
      {space.archived ? (
        <span className="shrink-0 mono text-micro text-graphite">archived</span>
      ) : (
        <button
          type="button"
          aria-label={`Remove from ${space.name}`}
          onClick={onRemove}
          className="focus-ring hidden size-5 items-center justify-center text-graphite group-hover:flex hover:text-foreground focus-visible:flex"
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      )}
    </RailItem>
  )
}
