import type { ReactNode } from 'react'
import { NOTE_EDGE } from './note-head'
import { cn } from '#/lib/utils'

/**
 * The note page's frame: the head across the top on its one rule, then the
 * body and the rail side by side (stacked under `md`).
 * - The body is one paper sheet, the editor and nothing else at the 72ch
 *   measure, on the head's left edge; the rail stands on the bone ground.
 * - The editor's wrapper adds no inset of its own: `NOTE_EDGE` holds the
 *   side menu, so the prose keeps the title's edge.
 */
export function NoteSheet({
  head,
  editor,
  rail,
}: {
  head: ReactNode
  editor: ReactNode
  rail: ReactNode
}) {
  return (
    <div className="flex min-h-full flex-col">
      {head}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="min-w-0 flex-1 bg-paper">
          <div
            data-note-body
            className={cn('max-w-[72ch] pt-6 pr-8 pb-8', NOTE_EDGE)}
          >
            <div className="prose-note">{editor}</div>
          </div>
        </div>
        {rail}
      </div>
    </div>
  )
}
