import { KindIcon } from '#/components/kind-icon'
import { NoteKindIcon } from '#/components/note-kind-icon'
import { ProviderMark, brandOf } from '#/components/provider-mark'
import type { Brand } from '#/components/provider-mark'
import type { NoteKind } from '#/lib/notes/ordering'
import type { NoteVia } from '#/lib/notes/via-mark'
import { cn } from '#/lib/utils'

/** The recorder whose logo a note leads on, or null for a note a person wrote. */
export function noteBrand(via: NoteVia | null): Brand | null {
  return via === null ? null : brandOf(via.tool)
}

/**
 * The one mark a note leads on, in its row and in its window alike: the
 * recorder's own logo for a note a recorder filed, else the kind icon.
 * - In a row it is 16px and the kind icon carries the kind as its name;
 *   leading a window's head (`head`) it is 20px and the control around it
 *   names it.
 * - `className` is a colour, never a size.
 */
export function NoteMark({
  kind,
  via,
  head = false,
  className,
}: {
  kind: NoteKind
  via: NoteVia | null
  head?: boolean | undefined
  className?: string | undefined
}) {
  const brand = noteBrand(via)
  if (brand !== null)
    return (
      <ProviderMark brand={brand} className={cn(head && 'size-5', className)} />
    )
  return head ? (
    <NoteKindIcon kind={kind} className={cn('size-5', className)} />
  ) : (
    <KindIcon of={{ kind: 'note', noteKind: kind }} className={className} />
  )
}
