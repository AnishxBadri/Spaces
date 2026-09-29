import { Link } from '@tanstack/react-router'
import { RecordSection } from '#/components/record/record-parts'

/**
 * A record's Notes section: one list, in the two lanes the filing decision
 * draws (CONTEXT.md → Filed vs referenced). What was filed against this
 * record comes first, in the order `listRecordNotesProgram` hands it; what
 * merely names the record follows, and says so with a `mention` stamp in
 * the row's mono end lane. The lane is a mark on the row, not a subhead
 * over it — two caps heads and two sentences for zero notes was the
 * commentary drift the design contract names (2026-09-30).
 *
 * Membership and order are decided upstream; this file renders and the
 * company / person / deal / custom pages share one rule.
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
  const rows = [
    ...filed.map((n) => ({ ...n, lane: 'filed' as const })),
    ...mentions.map((n) => ({ ...n, lane: 'mention' as const })),
  ]
  return (
    <RecordSection
      label="Notes"
      meta={
        rows.length === 0
          ? '0'
          : mentions.length === 0
            ? `${filed.length}`
            : `${filed.length} filed · ${mentions.length} mention${
                mentions.length === 1 ? '' : 's'
              }`
      }
      action={
        <button
          type="button"
          onClick={onNewNote}
          className="focus-ring text-primary hover:underline"
        >
          note about this ›
        </button>
      }
    >
      {rows.length === 0 ? (
        <p className="border-t border-rule py-2 text-label text-graphite">
          No notes.
        </p>
      ) : (
        <ol>
          {rows.map((n) => (
            <li key={n.id} className="border-t border-rule">
              <Link
                to="/notes/$noteId"
                params={{ noteId: n.id }}
                className="focus-ring-inset flex h-row items-center gap-3 text-ui hover:bg-bone"
              >
                <span className="min-w-0 truncate font-serif text-title font-medium">
                  {n.title}
                </span>
                <span className="flex-1" />
                {/* The mono lane the row ends on — the instrument's filing
                    stamp: which lane, what kind of note, when it last moved. */}
                <span className="shrink-0 mono text-micro text-graphite">
                  {n.lane === 'mention' ? 'mention · ' : ''}
                  {n.kind} · {n.updatedAt.slice(5, 10)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </RecordSection>
  )
}
