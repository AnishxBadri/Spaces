import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { FilterCount, FilterRow, FilterTab } from '#/components/filter-row'
import { KeyHint } from '#/components/page-header'
import {
  NOTES_FILTERS,
  NOTES_FILTER_LABELS,
  notesCounts,
  notesInFilter,
} from '#/lib/notes/notes-filter'
import type { NoteLanes, NotesFilter } from '#/lib/notes/notes-filter'
import { viaLabel } from '#/lib/notes/via-mark'
import type { NoteVia } from '#/lib/notes/via-mark'
import { useHotkey } from '#/lib/use-hotkey'

/**
 * A record's Notes tab: the filter row (All · Filed here · From meetings ·
 * Mentions), the `+ Write a note… N` composer row, then the notes the
 * filter lists in the lanes `listRecordNotesProgram` hands them. Under All
 * a note from a meeting or a mention carries its lane in the mono end lane.
 * - Every title is serif: what a person wrote or filed. A recorder's note
 *   adds "via <tool> · <author>" in mono (D78).
 * - The filter is the tab's own state unless the page holds it for the tab
 *   head's count.
 */

export type RecordNoteRow = {
  id: string
  title: string
  kind: 'note' | 'memo' | 'scratch'
  updatedAt: string
  via: NoteVia | null
}

export function RecordNotes({
  notes,
  onNewNote,
  filter: held,
  onFilterChange,
}: {
  notes: NoteLanes<RecordNoteRow>
  onNewNote: () => void
  /** The filter, when the page holds it. */
  filter?: NotesFilter
  onFilterChange?: (filter: NotesFilter) => void
}) {
  useHotkey('n', onNewNote)
  const [own, setOwn] = useState<NotesFilter>('all')
  const filter = held ?? own
  const setFilter = (next: NotesFilter) => {
    setOwn(next)
    onFilterChange?.(next)
  }
  const counts = notesCounts(notes)
  const rows = notesInFilter(notes, filter)
  return (
    <div className="flex flex-col">
      <FilterRow label="Show notes">
        {NOTES_FILTERS.map((f) => (
          <FilterTab key={f} active={filter === f} onClick={() => setFilter(f)}>
            {NOTES_FILTER_LABELS[f]} <FilterCount n={counts[f]} />
          </FilterTab>
        ))}
      </FilterRow>
      <ol>
        <li className="border-b border-rule">
          <button
            type="button"
            onClick={onNewNote}
            className="focus-ring-inset flex h-ledger-row w-full items-center gap-3 px-3 text-left hover:bg-bone"
          >
            <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
              +
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-graphite">
              Write a note…
            </span>
            <KeyHint>N</KeyHint>
          </button>
        </li>
        {rows.map((n) => (
          <li key={n.id} className="border-b border-rule">
            <Link
              to="/notes/$noteId"
              params={{ noteId: n.id }}
              className="focus-ring-inset flex h-ledger-row items-center gap-3 px-3 text-ui hover:bg-bone"
            >
              <span className="min-w-0 truncate font-serif text-title font-medium">
                {n.title}
              </span>
              <span className="flex-1" />
              {/* The mono lane the row ends on: which lane under All, the
                  tool it was filed from, what kind of note, when it last
                  moved. */}
              <span className="shrink-0 mono text-micro text-graphite">
                {filter === 'all' && n.lane !== 'filed' ? `${n.lane} · ` : ''}
                {n.via === null ? '' : `${viaLabel(n.via)} · `}
                {n.kind} · {n.updatedAt.slice(5, 10)}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  )
}
