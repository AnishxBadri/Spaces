import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'

/**
 * The query behind `listNotes`, minus the request context, so tests can run
 * it without a session.
 * - No kind predicate, and must not grow one: a scratch note is listed like
 *   any other.
 * - Kept out of the server-fn modules: a plain export there keeps its imports
 *   alive in the client bundle.
 */
export async function listNoteRows(userId: string) {
  return db
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
      ),
    )
    .orderBy(desc(note.updatedAt))
}
