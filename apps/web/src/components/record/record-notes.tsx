import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Band, Day, FoldRow } from '#/components/ledger-section'
import { SplitNewButton } from '#/components/new-button'
import { NoteMark } from '#/components/notes/note-mark'
import { TemplatePicker } from '#/components/templates'
import { Segmented } from '#/components/ui/segmented'
import {
  createNote,
  createNoteFromTemplate,
  fileNoteAgainst,
} from '#/lib/server-fns'
import { openModalId } from '#/lib/modal-search'
import {
  NOTE_FILTERS,
  filterNoteGroups,
  noteFilterCounts,
  recordNoteGroups,
} from '#/lib/notes/record-groups'
import type { NoteFilter, NoteLanes } from '#/lib/notes/record-groups'
import type { NoteVia } from '#/lib/notes/via-mark'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/**
 * A record's Notes tab: a toolbar (the kinds as a `Segmented`, the split
 * `New note ⌄` at its right), the notes filed here (memos first), a
 * `FROM MEETINGS` band over the meetings' notes, and one `n superseded`
 * fold at the foot. Empty, it is the toolbar alone with `No notes yet`.
 * - A row: one leading mark (the kind icon, or the recorder's logo for a
 *   note a recorder filed), the serif title, its people (the author, or the
 *   meeting's attendees) and the day, then the excerpt.
 * - A row opens its note in a window over the record (`?modal=note&id=`),
 *   and stays on bone behind it. A new note, blank or from a template, is
 *   born filed here and opens in the same window.
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

/** The record a new note is born about, as `createNote` takes it. */
export type NoteAbout = {
  entityId: string
  label: string
  kind: string
  objectSlug?: string
}

/** The people lane: a meeting's attendees, else the author. */
export function notePeople(n: RecordNoteRow): string {
  return n.attendees.length > 0 ? n.attendees.join(' · ') : (n.author ?? '')
}

const FILTER_LABELS: Record<NoteFilter, string> = {
  all: 'All',
  memo: 'Memos',
  note: 'Notes',
  meeting: 'Meetings',
}

export function RecordNotes({
  notes,
  about,
}: {
  notes: NoteLanes<RecordNoteRow>
  about: NoteAbout
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const opened = openModalId(useSearch({ strict: false }), 'note')
  const [filter, setFilter] = useState<NoteFilter>('all')
  const [unfolded, setUnfolded] = useState(false)

  function open(id: string) {
    void navigate({
      to: '.',
      search: (prev) => ({
        ...prev,
        tab: 'notes' as const,
        modal: 'note' as const,
        id,
      }),
      resetScroll: false,
    })
    void router.invalidate()
  }

  async function newNote() {
    try {
      const { id } = await createNote({ data: { about } })
      open(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  async function fromTemplate(templateId: string) {
    try {
      const { id } = await createNoteFromTemplate({ data: { templateId } })
      // A template's note is born about nothing; this one is filed here.
      await fileNoteAgainst({ data: { id, targetId: about.entityId } })
      open(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  useHotkey('n', () => void newNote())
  const groups = recordNoteGroups(notes)
  const counts = noteFilterCounts(groups)
  const shown = filterNoteGroups(groups, filter)
  const empty =
    groups.notes.length + groups.meetings.length + groups.superseded.length ===
    0
  const listed = shown.notes.length + shown.meetings.length

  // The open note's row unfolds rather than hiding behind the fold.
  const foldOpen = unfolded || shown.superseded.some((n) => n.id === opened)

  return (
    <div className="flex flex-col">
      <div
        data-notes-toolbar
        className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-rule px-3"
      >
        {empty ? (
          <span className="text-ui text-graphite">No notes yet</span>
        ) : (
          <Segmented
            label="Show notes"
            value={filter}
            onChange={setFilter}
            options={NOTE_FILTERS.map((f) =>
              f === 'all'
                ? { id: f, label: FILTER_LABELS[f] }
                : { id: f, label: FILTER_LABELS[f], count: counts[f] },
            )}
          />
        )}
        <SplitNewButton
          noun="note"
          variant="secondary"
          shortcut="N"
          onNew={() => void newNote()}
          templates={(trigger) => (
            <TemplatePicker
              kind="note"
              context={about.kind}
              trigger={trigger}
              onPick={(t) => void fromTemplate(t.id)}
            />
          )}
        />
      </div>
      {shown.notes.length > 0 ? (
        <ul>
          {shown.notes.map((n) => (
            <NoteRow key={n.id} note={n} highlighted={n.id === opened} />
          ))}
        </ul>
      ) : null}
      {shown.meetings.length > 0 ? (
        <section aria-label="From meetings" className="flex flex-col">
          <Band label="From meetings" />
          <ul>
            {shown.meetings.map((n) => (
              <NoteRow key={n.id} note={n} highlighted={n.id === opened} />
            ))}
          </ul>
        </section>
      ) : null}
      {!empty && listed === 0 && shown.superseded.length === 0 ? (
        <p className="px-3 py-2 text-label text-graphite">
          Nothing matches that filter.
        </p>
      ) : null}
      {shown.superseded.length === 0 ? null : foldOpen ? (
        <ul data-superseded>
          {shown.superseded.map((n) => (
            <NoteRow key={n.id} note={n} highlighted={n.id === opened} />
          ))}
        </ul>
      ) : (
        <FoldRow
          hidden={shown.superseded.length}
          noun="superseded"
          onShow={() => setUnfolded(true)}
          // The rows above end on their own rule.
          className="border-t-0"
        />
      )}
    </div>
  )
}

function NoteRow({
  note: n,
  highlighted,
}: {
  note: RecordNoteRow
  /** The note whose window is open over the tab: on bone behind it. */
  highlighted: boolean
}) {
  const superseded = n.supersededBy !== null
  // Opened from a link, the row may sit below the folder's fold.
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (highlighted) row.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  return (
    <li
      ref={row}
      data-note={n.id}
      data-highlighted={highlighted ? '' : undefined}
      className={cn('border-b border-rule', highlighted && 'bg-bone')}
    >
      <Link
        to="."
        search={(prev) => ({
          ...prev,
          tab: 'notes' as const,
          modal: 'note' as const,
          id: n.id,
        })}
        resetScroll={false}
        className={cn(
          'focus-ring-inset flex flex-col px-(--inset) hover:bg-bone',
          superseded ? 'h-ledger-row justify-center' : 'py-2.25',
        )}
      >
        <span className="flex min-h-5 min-w-0 items-center gap-3">
          <span data-note-mark className="flex w-4 shrink-0 justify-center">
            <NoteMark kind={n.kind} via={n.via} />
          </span>
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
