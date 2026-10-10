import { Link } from '@tanstack/react-router'
import { KeyHint } from '#/components/page-header'
import { useHotkey } from '#/lib/use-hotkey'

/**
 * A record's Notes tab: the `+ Write a note… N` composer row, then one list
 * in the two lanes the filing decision draws (CONTEXT.md → Filed vs
 * referenced). What was filed against this record comes first, in the
 * order `listRecordNotesProgram` hands it; what merely names the record
 * follows, with a `mention` stamp in the row's mono end lane.
 * - The tab head is the section head: the view starts on paper, no band.
 */

export type RecordNoteRow = {
  id: string
  title: string
  kind: 'note' | 'memo' | 'scratch'
  updatedAt: string
}

export function RecordNotes({
  filed,
  mentions,
  onNewNote,
}: {
  filed: Array<RecordNoteRow>
  mentions: Array<RecordNoteRow>
  onNewNote: () => void
}) {
  useHotkey('n', onNewNote)
  const rows = [
    ...filed.map((n) => ({ ...n, lane: 'filed' as const })),
    ...mentions.map((n) => ({ ...n, lane: 'mention' as const })),
  ]
  return (
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
            {/* The mono lane the row ends on: which lane, what kind of
                note, when it last moved. */}
            <span className="shrink-0 mono text-micro text-graphite">
              {n.lane === 'mention' ? 'mention · ' : ''}
              {n.kind} · {n.updatedAt.slice(5, 10)}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  )
}
