import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { EmailDialog } from '#/components/email-dialog'
import { NoteWindow } from '#/components/notes/note-window'
import { ThreadRow } from '#/components/record/thread-row'
import { recordPath } from '#/lib/record-path'
import type { MeetingRecord, RecentRow } from '#/lib/server-fns'
import { CARD_LINK, SheetCard } from './sheet-card'

/**
 * `Recent`, before the meeting: the last few things on its records the
 * reader may read, newest first, as thread rows. The head goes to the
 * record; a row opens its window. With nothing to show there is no card.
 * - A meeting or a call opens in the meeting window by the URL, as every
 *   page that holds one does; an email and a note open in a window of
 *   their own over this one, since not every page hosts theirs.
 * - Over a record (`onOpenNote`) a note opens in the record's note window.
 */
export function RecentCard({
  record,
  rows,
  onOpenNote,
}: {
  record: MeetingRecord | null
  rows: ReadonlyArray<RecentRow>
  onOpenNote: ((noteId: string) => void) | undefined
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [noteId, setNoteId] = useState<string | null>(null)
  if (rows.length === 0) return null
  const to = record === null ? null : recordPath(record)

  function open(row: RecentRow) {
    if (row.kind === 'email') return setEmail(row.id)
    if (row.kind === 'note')
      return onOpenNote === undefined ? setNoteId(row.id) : onOpenNote(row.id)
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, modal: 'meeting' as const, id: row.id }),
      resetScroll: false,
    })
  }

  return (
    <SheetCard
      label="Recent"
      action={
        record === null || to === null ? undefined : (
          <Link to={to} className={CARD_LINK}>
            {record.name} ›
          </Link>
        )
      }
    >
      <ol>
        {rows.map((row, i) => (
          <ThreadRow
            key={row.id}
            item={row}
            messages={row.messages}
            last={i === rows.length - 1}
            people={false}
            onOpen={() => open(row)}
          />
        ))}
      </ol>
      <EmailDialog
        id={email}
        onOpenChange={(o) => {
          if (!o) setEmail(null)
        }}
      />
      <NoteWindow
        id={noteId}
        onClose={() => setNoteId(null)}
        onOpenPage={(id) => {
          setNoteId(null)
          void router.navigate({ to: '/notes/$noteId', params: { noteId: id } })
        }}
      />
    </SheetCard>
  )
}
