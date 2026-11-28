import type { ReactNode } from 'react'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { OpenIn } from '#/components/open-in'
import type { MeetingDetail } from '#/lib/server-fns'
import { NoteLink } from './note-link'
import { CARD_LINK, SheetCard } from './sheet-card'

/**
 * The meeting's write-up, read in place: the recorder's mark when a
 * recorder wrote it, `Open note ›`, and the text in serif. The read hands
 * over no title or text when the reader may not read it, and the card
 * says so.
 */
export function WriteUpCard({
  note,
  onOpenNote,
  carried,
}: {
  note: NonNullable<MeetingDetail['note']>
  onOpenNote: ((noteId: string) => void) | undefined
  /** The meeting's other notes and files, under the text. */
  carried: ReactNode
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
