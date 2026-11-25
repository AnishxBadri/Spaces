import { Effect } from 'effect'
import { and, desc, eq, isNull, notExists, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, interaction, note } from '@spaces/db/schema'
import { notesQuery } from './query'

/**
 * The query behind `listNotes`, minus the request context, so tests can run
 * it without a session.
 * - No kind predicate, and must not grow one: every kind is listed.
 * - An email keeps its text in a note row so one gate reads both; that row
 *   is mail, read on the Email page, and is not listed here. A meeting's
 *   write-up is a note and is.
 * - Kept out of the server-fn modules: a plain export there keeps its imports
 *   alive in the client bundle.
 */
export const listNoteRowsProgram = Effect.fn('listNoteRows')(function* (
  userId: string,
) {
  return yield* notesQuery(() =>
    db
      .select({
        id: note.entityId,
        title: note.title,
        bodyMd: note.bodyMd,
        kind: note.kind,
        updatedAt: note.updatedAt,
        authorId: note.authorId,
        visibility: note.visibility,
      })
      .from(note)
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(
        and(
          isNull(entity.mergedIntoId),
          // canRead in SQL: shared, or private-and-mine.
          or(eq(note.visibility, 'shared'), eq(note.authorId, userId)),
          notExists(
            db
              .select({ id: interaction.id })
              .from(interaction)
              .where(
                and(
                  eq(interaction.noteId, note.entityId),
                  eq(interaction.kind, 'email'),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(note.updatedAt)),
  )
})

/** {@link listNoteRowsProgram}, for a caller that is not a program. */
export const listNoteRows = (userId: string) =>
  Effect.runPromise(listNoteRowsProgram(userId))
