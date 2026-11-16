import { notFound } from '@tanstack/react-router'
import { Schema } from 'effect'
import { getNote, listSpaces, listTermsForNote } from '#/lib/server-fns'

/** The id shape `getNote` validates; anything else is a wrong link. */
const isNoteId = Schema.is(Schema.String.check(Schema.isUUID()))

/**
 * What a note's page loads. A note that is not there, or not the reader's to
 * see, throws `notFound()` so the route shows its not-found screen; every
 * other failure rejects as it came and reaches the error screen.
 * - An id that is not a uuid is a wrong link too, never a failed read.
 */
export async function loadNotePage(noteId: string) {
  if (!isNoteId(noteId)) throw notFound()
  const [note, allSpaces, terms] = await Promise.all([
    getNote({ data: { id: noteId } }),
    listSpaces(),
    listTermsForNote({ data: { noteId } }),
  ])
  if (note === null) throw notFound()
  return { note, allSpaces, terms }
}
