import { Link } from '@tanstack/react-router'
import { RecordSection } from '#/components/record/record-parts'

/**
 * A record's Notes section, in the two lanes the filing decision draws
 * (CONTEXT.md → Filed vs referenced): what was deliberately filed against
 * this record, and what merely names it. Composed on `RecordSection`, the
 * record shape's own primitive — no new anatomy.
 *
 * The lanes are supplied already split and already ordered by
 * `listRecordNotesProgram`; this file decides nothing about membership or
 * order, so the company / person / deal / custom pages of notes-1b share one
 * rule rather than four renderings of it.
 */

export type RecordNoteRow = {
  id: string
  title: string
  kind: 'note' | 'memo' | 'scratch'
  updatedAt: string
}

export function RecordNotes({
  recordName,
  filed,
  mentions,
  onNewNote,
}: {
  recordName: string
  filed: Array<RecordNoteRow>
  mentions: Array<RecordNoteRow>
  onNewNote: () => void
}) {
  return (
    <RecordSection
      label="Notes"
      meta={`${filed.length} filed · ${mentions.length} mention${
        mentions.length === 1 ? '' : 's'
      }`}
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
      <NoteLane
        label="Filed here"
        rows={filed}
        empty={`Nothing is filed against ${recordName} yet. “Note about this” files one here.`}
      />
      <NoteLane
        label="Mentions this"
        rows={mentions}
        empty={`No other note names ${recordName}. @mention it and the note lands here.`}
      />
    </RecordSection>
  )
}

/** One lane: a caps head, then rows on rules, or the lane's own empty line. */
function NoteLane({
  label,
  rows,
  empty,
}: {
  label: string
  rows: Array<RecordNoteRow>
  empty: string
}) {
  return (
    <div className="flex flex-col pt-2 first:pt-0">
      <h3 className="pb-1 label-caps text-graphite">{label}</h3>
      {rows.length === 0 ? (
        <p className="border-t border-rule py-2 text-label text-graphite">
          {empty}
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
                    stamp: what kind of note this is, and when it last moved. */}
                <span className="shrink-0 mono text-micro text-graphite">
                  {n.kind} · {n.updatedAt.slice(5, 10)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
