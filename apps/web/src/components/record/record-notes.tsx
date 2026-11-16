import { Link } from '@tanstack/react-router'
import { CalendarDays } from '#/components/icons'
import { KindIcon } from '#/components/kind-icon'
import { Band, Day, EmptyRow } from '#/components/ledger-section'
import { recordNoteGroups } from '#/lib/notes/record-groups'
import type { NoteLanes } from '#/lib/notes/record-groups'
import type { NoteVia } from '#/lib/notes/via-mark'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/**
 * A record's Notes tab: the `+ Write a note… N` composer, the notes filed
 * here (memos first), a `FROM MEETINGS` band over the meetings' notes, and
 * every superseded note last on one graphite line. With no notes it is the
 * one `Notes +` row.
 * - A row: the kind icon (note or memo; a meeting's note its calendar),
 *   the serif title, its people (the author, or the meeting's attendees),
 *   the state lane in mono and the day, then the excerpt.
 * - The state lane prints `via Granola` or `superseded` and nothing else:
 *   the kind is the icon.
 */

export type RecordNoteRow = {
  id: string
  title: string
  kind: 'note' | 'memo'
  updatedAt: string
  via: NoteVia | null
  author: string | null
  attendees: ReadonlyArray<string>
  excerpt: string | null
  supersededBy: string | null
}

/** The mono lane: a state word only, never the kind, which the icon says. */
export function noteKindLane(n: RecordNoteRow): string {
  if (n.supersededBy !== null) return 'superseded'
  if (n.via !== null) return `via ${n.via.tool}`
  return ''
}

/** The people lane: a meeting's attendees, else the author. */
export function notePeople(n: RecordNoteRow): string {
  return n.attendees.length > 0 ? n.attendees.join(' · ') : (n.author ?? '')
}

export function RecordNotes({
  notes,
  onNewNote,
}: {
  notes: NoteLanes<RecordNoteRow>
  onNewNote: () => void
}) {
  useHotkey('n', onNewNote)
  const groups = recordNoteGroups(notes)
  const empty =
    groups.notes.length + groups.meetings.length + groups.superseded.length ===
    0
  if (empty) return <EmptyRow name="Notes" onAdd={onNewNote} />
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onNewNote}
        className="focus-ring-inset flex h-ledger-row w-full items-center gap-3 border-b border-rule px-(--inset) text-left hover:bg-bone"
      >
        <span className="w-4 shrink-0 text-center mono text-ui text-primary">
          +
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-graphite">
          Write a note…
        </span>
        <kbd className="shrink-0 mono text-micro text-graphite">N</kbd>
      </button>
      {groups.notes.length > 0 ? (
        <ul>
          {groups.notes.map((n) => (
            <NoteRow key={n.id} note={n} />
          ))}
        </ul>
      ) : null}
      {groups.meetings.length > 0 ? (
        <section aria-label="From meetings" className="flex flex-col">
          <Band label="From meetings" />
          <ul>
            {groups.meetings.map((n) => (
              <NoteRow key={n.id} note={n} meeting />
            ))}
          </ul>
        </section>
      ) : null}
      {groups.superseded.length > 0 ? (
        <ul>
          {groups.superseded.map((n) => (
            <NoteRow key={n.id} note={n} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function NoteRow({
  note: n,
  meeting = false,
}: {
  note: RecordNoteRow
  meeting?: boolean
}) {
  const superseded = n.supersededBy !== null
  return (
    <li data-note={n.id} className="border-b border-rule">
      <Link
        to="/notes/$noteId"
        params={{ noteId: n.id }}
        className={cn(
          'focus-ring-inset flex flex-col px-(--inset) hover:bg-bone',
          superseded ? 'h-ledger-row justify-center' : 'py-2.25',
        )}
      >
        <span className="flex min-h-5 min-w-0 items-center gap-3">
          {meeting ? (
            <span aria-hidden className="flex w-4 shrink-0 justify-center">
              <CalendarDays className="size-4 text-graphite" />
            </span>
          ) : (
            // As the Notes list draws it: a memo in ink, a note in graphite.
            <KindIcon
              of={{ kind: 'note', noteKind: n.kind }}
              className={
                n.kind === 'memo' && !superseded ? 'text-foreground' : undefined
              }
            />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-serif text-title',
              superseded ? 'text-graphite' : 'text-foreground',
            )}
          >
            {n.title}
          </span>
          <span
            data-people
            className="w-50 shrink-0 truncate text-label text-graphite"
          >
            {notePeople(n)}
          </span>
          <span
            data-kind
            className="w-24 shrink-0 truncate text-right mono text-micro text-graphite"
          >
            {noteKindLane(n)}
          </span>
          <Day at={n.updatedAt} />
        </span>
        {superseded || n.excerpt === null ? null : (
          <span
            data-excerpt
            className="truncate pr-30 pl-7 text-label text-graphite"
          >
            {n.excerpt}
          </span>
        )}
      </Link>
    </li>
  )
}
