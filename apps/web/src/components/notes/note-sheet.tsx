import type { ReactNode } from 'react'
import { NOTE_INSET } from '#/components/editor/note-column'
import { cn } from '#/lib/utils'

/**
 * The note page's frame: the head across the top on its one rule, then the
 * bone ground with the record body's 12px gutter, the body card and the
 * rail side by side (the rail stacked under the card below `md`).
 * - The card is one paper sheet in a 1px ink edge, holding the editor alone
 *   at the 72ch measure, left on the card's gutter, not centred.
 * - The card's gutter is `NOTE_INSET`, the editor's own margin, where the
 *   side menu floats: the prose stands 12px + the gutter in from the page,
 *   not under the title.
 * - Nothing from the card up to the page's scroller clips: BlockNote's
 *   floating sheets, side menu, table handles and drag preview draw
 *   outside the text column.
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
      <div
        data-note-ground
        className="flex min-h-0 flex-1 flex-col gap-3 bg-bone p-3 md:flex-row"
      >
        <div
          data-note-card
          className="min-w-0 flex-1 border border-hairline bg-paper"
        >
          <div
            data-note-body
            className={cn('max-w-[72ch] pt-6 pr-8 pb-8', NOTE_INSET)}
          >
            <div className="prose-note">{editor}</div>
          </div>
        </div>
        {rail}
      </div>
    </div>
  )
}
