import type { MeetingRsvp } from '@spaces/db/schema/interactions'
import { cellsFor } from '#/components/dither'
import { REPLY } from '#/lib/meetings/sheet'
import { cn } from '#/lib/utils'

/** The 8px dithered square: half its 2px cells in ink. */
function DitheredSquare() {
  return (
    <svg
      aria-hidden
      width="8"
      height="8"
      viewBox="0 0 8 8"
      shapeRendering="crispEdges"
      className="size-2 shrink-0 text-foreground"
    >
      {cellsFor(8).map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width="2"
          height="2"
          fill="currentColor"
        />
      ))}
    </svg>
  )
}

/**
 * How a person answered the invite, at their row's end: an 8px square and
 * the word. Filled `Yes`, dithered `Maybe`, hollow `No reply`, and hollow
 * graphite with the word struck for `Declined`. Shown, never edited.
 */
export function ReplyMark({ rsvp }: { rsvp: MeetingRsvp }) {
  const reply = REPLY[rsvp]
  return (
    <span
      data-reply={rsvp}
      data-square={reply.square}
      className="flex shrink-0 items-center gap-1.5"
    >
      {reply.square === 'dithered' ? (
        <DitheredSquare />
      ) : (
        <span
          aria-hidden
          className={cn(
            'size-2 shrink-0',
            reply.square === 'filled'
              ? 'bg-hairline'
              : reply.struck
                ? 'border border-graphite'
                : 'border border-hairline',
          )}
        />
      )}
      <span
        className={cn(
          'w-15 shrink-0 mono text-micro whitespace-nowrap text-graphite',
          reply.struck && 'line-through',
        )}
      >
        {reply.word}
      </span>
    </span>
  )
}
