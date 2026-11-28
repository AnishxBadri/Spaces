import type { ReactNode } from 'react'
import { useOpenFile } from '#/components/files/file-window-nav'
import { OpenIn } from '#/components/open-in'
import type { MeetingArtifact, MeetingCarriedNote } from '#/lib/server-fns'
import { NoteLink } from './note-link'
import { SheetCard } from './sheet-card'

const ROLE_WORD: Record<MeetingArtifact['role'], string> = {
  transcript: 'Transcript',
  recording_link: 'Recording',
  attachment: 'Attachment',
}

/** A note beyond the write-up, or an artifact, as one bordered row. */
function CarriedRow({
  children,
  end,
}: {
  children: ReactNode
  end?: ReactNode
}) {
  return (
    <li className="flex min-h-10 items-center gap-3 border border-rule px-3">
      {children}
      {end}
    </li>
  )
}

function NoteRow({
  n,
  onOpenNote,
}: {
  n: MeetingCarriedNote
  onOpenNote: ((noteId: string) => void) | undefined
}) {
  return (
    <CarriedRow end={<OpenIn link={n.openIn} />}>
      <NoteLink
        id={n.id}
        onOpenNote={onOpenNote}
        className="focus-ring min-w-0 flex-1 truncate text-body hover:underline"
      >
        {n.title}
      </NoteLink>
      {n.via === null ? null : (
        <span className="shrink-0 mono text-micro text-graphite">
          {`Via ${n.via.tool} · ${n.via.author}`}
        </span>
      )}
    </CarriedRow>
  )
}

function ArtifactRow({ a }: { a: MeetingArtifact }) {
  const openFile = useOpenFile()
  return (
    <CarriedRow>
      <span className="w-20 shrink-0 label-caps text-graphite">
        {ROLE_WORD[a.role]}
      </span>
      {a.role === 'recording_link' ? (
        a.url === null ? (
          <span className="min-w-0 flex-1 truncate text-body">{a.name}</span>
        ) : (
          <a
            href={a.url}
            target="_blank"
            rel="noreferrer"
            title="Opens the recording where it is kept"
            className="focus-ring min-w-0 flex-1 truncate text-body hover:underline"
          >
            {a.name}
          </a>
        )
      ) : (
        <button
          type="button"
          onClick={() => openFile(a.documentId)}
          className="focus-ring min-w-0 flex-1 truncate text-left text-body hover:underline"
        >
          {a.name}
        </button>
      )}
    </CarriedRow>
  )
}

/**
 * What the meeting carries besides its write-up: second notes and the
 * transcript, recording or files, each a bordered row. Null when empty.
 */
export function CarriedList({
  notes,
  artifacts,
  onOpenNote,
}: {
  notes: ReadonlyArray<MeetingCarriedNote>
  artifacts: ReadonlyArray<MeetingArtifact>
  onOpenNote: ((noteId: string) => void) | undefined
}) {
  if (notes.length + artifacts.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5">
      {artifacts.map((a) => (
        <ArtifactRow key={a.documentId} a={a} />
      ))}
      {notes.map((n) => (
        <NoteRow key={n.id} n={n} onOpenNote={onOpenNote} />
      ))}
    </ul>
  )
}

/**
 * A card of carried things with no write-up card to hold them: the shared
 * ones under `Notes and files`, the reader's own under `Private to you`.
 */
export function CarriedCard({
  label,
  notes,
  artifacts,
  onOpenNote,
}: {
  label: 'Notes and files' | 'Private to you'
  notes: ReadonlyArray<MeetingCarriedNote>
  artifacts: ReadonlyArray<MeetingArtifact>
  onOpenNote: ((noteId: string) => void) | undefined
}) {
  if (notes.length + artifacts.length === 0) return null
  return (
    <SheetCard label={label}>
      <div className="p-(--inset)">
        <CarriedList
          notes={notes}
          artifacts={artifacts}
          onOpenNote={onOpenNote}
        />
      </div>
    </SheetCard>
  )
}
