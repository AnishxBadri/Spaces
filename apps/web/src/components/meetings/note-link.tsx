import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * A note the sheet names: its window over the record when `onOpenNote` is
 * given, else its page.
 */
export function NoteLink({
  id,
  onOpenNote,
  className,
  children,
}: {
  id: string
  onOpenNote: ((noteId: string) => void) | undefined
  className: string
  children: ReactNode
}) {
  return onOpenNote === undefined ? (
    <Link to="/notes/$noteId" params={{ noteId: id }} className={className}>
      {children}
    </Link>
  ) : (
    <button
      type="button"
      data-note-link={id}
      onClick={() => onOpenNote(id)}
      className={cn('text-left', className)}
    >
      {children}
    </button>
  )
}
