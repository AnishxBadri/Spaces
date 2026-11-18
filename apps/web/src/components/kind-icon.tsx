import { CubeView, KIND_ICONS } from '#/components/icons'
import { NOTE_KIND_LABEL, NoteKindIcon } from '#/components/note-kind-icon'
import type { NoteKind } from '#/lib/notes/ordering'
import { objectIcon } from '#/lib/object-icons'
import { cn } from '#/lib/utils'

/** What a kind icon reads off a record: its kind, and the finer kind when known. */
export type KindOf = {
  kind: string
  /** A custom record's object's singular, its kind word. */
  objectLabel?: string | null | undefined
  /** A custom record's object's chosen icon, by `OBJECT_ICONS` name. */
  objectIcon?: string | null | undefined
  /** A note's own kind: note or memo. */
  noteKind?: NoteKind | null | undefined
}

const KIND_WORDS: Readonly<Partial<Record<string, string>>> = {
  company: 'Company',
  person: 'Person',
  deal: 'Deal',
  space: 'Space',
  note: 'Note',
  document: 'File',
  custom: 'Record',
  term: 'Term',
}

/** The kind's word, sentence case: the icon's tooltip and its name. */
function kindWord(of: KindOf): string {
  if (of.noteKind) return NOTE_KIND_LABEL[of.noteKind]
  if (of.objectLabel) return of.objectLabel
  return KIND_WORDS[of.kind] ?? of.kind
}

/**
 * A record's kind as its leading icon, graphite at 16px, with the kind word
 * as its tooltip and its accessible name — never the word beside it. A note
 * draws its own kind (note or memo); a custom record its object's glyph.
 */
export function KindIcon({
  of,
  className,
}: {
  of: KindOf
  /** Merged over the graphite: a colour, never a size. */
  className?: string | undefined
}) {
  const word = kindWord(of)
  // A kind the map does not know reads as a record: the box.
  const Glyph =
    of.kind === 'custom'
      ? objectIcon({ icon: of.objectIcon ?? null })
      : (KIND_ICONS[of.kind] ?? CubeView)
  return (
    <span
      role="img"
      aria-label={word}
      title={word}
      data-kind-icon={of.kind}
      className={cn('flex shrink-0 text-graphite', className)}
    >
      {of.kind === 'note' ? (
        <NoteKindIcon kind={of.noteKind ?? 'note'} />
      ) : (
        <Glyph aria-hidden />
      )}
    </span>
  )
}
