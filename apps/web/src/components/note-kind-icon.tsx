import { forwardRef } from 'react'
import type { Ref } from 'react'
import type { IconComponent, IconProps } from '#/components/icons'
import type { NoteKind } from '#/lib/notes/ordering'
import { cn } from '#/lib/utils'

/**
 * A note's kind as a glyph: our own concept, so our own drawing, on Carbon's
 * 32-grid as filled 2px bars with square ends, so it sits beside Carbon
 * icons without a seam.
 * - note: a page with a folded corner and two lines (Carbon's document,
 *   square-cornered); memo: the same page under a square seal low right,
 *   the written-up kind.
 */
// The page cut out evenodd: its outline, its body, the fold's triangle.
const PAGE = 'M6 2H18L26 10V30H6Z M8 4V28H24V12H16V4Z M18 4.4V10H23.6Z'

const PATHS: Record<NoteKind, Array<string>> = {
  note: [PAGE, 'M10 16H22V18H10Z', 'M10 22H22V24H10Z'],
  memo: [PAGE, 'M10 16H22V18H10Z', 'M10 22H14V24H10Z', 'M16 20H22V26H16Z'],
}

export function NoteKindIcon({
  kind,
  className,
  ref,
}: {
  kind: NoteKind
  className?: string | undefined
  ref?: Ref<SVGSVGElement> | undefined
}) {
  return (
    <svg
      ref={ref}
      aria-hidden
      data-note-kind={kind}
      viewBox="0 0 32 32"
      fill="currentColor"
      fillRule="evenodd"
      className={cn('size-4 shrink-0', className)}
    >
      {PATHS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

/**
 * The note glyph as an icon-list entry, for a row that names a note without
 * knowing its kind (a mention chip, a Cmd-K hit). Honours `className` alone:
 * the glyph is always 16px and always decorative.
 */
export const NoteIcon: IconComponent = forwardRef<SVGSVGElement, IconProps>(
  function NoteIcon({ className }, ref) {
    return <NoteKindIcon ref={ref} kind="note" className={className} />
  },
)

/** The kind's name, for a glyph's label. */
export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  note: 'Note',
  memo: 'Memo',
}
