import type { NoteKind } from '#/lib/notes/ordering'
import { cn } from '#/lib/utils'

/**
 * A note's kind as a glyph: our own concept, so our own drawing, on
 * Lucide's 24-grid with its 2px round stroke so it sits beside Lucide icons
 * without a seam.
 * - note: a page of lines; memo: a page under a seal, the written-up kind.
 */
const PATHS: Record<NoteKind, Array<string>> = {
  note: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  memo: [
    'M6 3h12v18H6z',
    'M9 7h6',
    'M9 11h6',
    'M14.5 14.5a2.5 2.5 0 1 0 0 .01',
  ],
}

export function NoteKindIcon({
  kind,
  className,
}: {
  kind: NoteKind
  className?: string | undefined
}) {
  return (
    <svg
      aria-hidden
      data-note-kind={kind}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}
    >
      {PATHS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

/** The kind's name, for a glyph's label. */
export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  note: 'Note',
  memo: 'Memo',
}
