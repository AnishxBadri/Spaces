import type { ReactNode } from 'react'
import { icon } from '#/components/icons'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { OpenIn } from '#/components/open-in'
import { MoreMenu } from '#/components/ui/more-menu'
import type { MeetingDetail } from '#/lib/server-fns'
import { NoteLink } from './note-link'
import { CARD_LINK, SheetCard } from './sheet-card'

/**
 * The meeting's write-up, read in place: the recorder's mark when a
 * recorder wrote it, `Open note ›`, its `···`, and the text in serif. The
 * read hands over no title or text when the reader may not read it, and
 * the card says so.
 * - `Find action items` reads the write-up again for items added since its
 *   first read; it is offered only on a write-up the reader may read.
 */
export function WriteUpCard({
  note,
  onOpenNote,
  carried,
  onFindActionItems,
}: {
  note: NonNullable<MeetingDetail['note']>
  onOpenNote: ((noteId: string) => void) | undefined
  /** The meeting's other notes and files, under the text. */
  carried: ReactNode
  onFindActionItems: () => void
}) {
  const readable = note.title !== null
  const body = note.body?.trim() ?? ''
  return (
    <SheetCard
      label="Write-up"
      headClassName="h-9 gap-2"
      lead={
        note.via === null ? null : (
          <span title={`Via ${note.via.tool} · ${note.via.author}`}>
            <PluginMark name={note.via.tool} />
          </span>
        )
      }
      action={
        readable ? (
          <>
            <OpenIn link={note.openIn} />
            <NoteLink
              id={note.id}
              onOpenNote={onOpenNote}
              className={CARD_LINK}
            >
              Open note ›
            </NoteLink>
            <MoreMenu
              variant="row"
              label="More for the write-up"
              forceMenu
              items={[
                {
                  label: 'Find action items',
                  icon: <icon.extract />,
                  title: 'Reads the write-up again for items added since',
                  onSelect: onFindActionItems,
                },
              ]}
            />
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
        {!readable ? (
          <p className="text-ui text-graphite">Private to its author.</p>
        ) : body === '' ? (
          <p className="font-serif text-title leading-6 text-foreground">
            {note.title}
          </p>
        ) : (
          <div
            data-write-up-body
            className="font-serif text-title leading-6 whitespace-pre-wrap text-foreground"
          >
            {note.body}
          </div>
        )}
        {carried}
      </div>
    </SheetCard>
  )
}
