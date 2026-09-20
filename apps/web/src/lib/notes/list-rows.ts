import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'

/**
 * The query behind `listNotes`, minus the request context, so the rows can
 * be exercised without a session — the same reason `entitySearchRows` exists.
 * It has no kind predicate and must not grow one: a scratch note is a note
 * that is listed like any other (SPA-109).
 *
 * It lives outside `lib/server/` because a plain export from a
 * `lib/server/*.ts` module keeps its imports alive in the client bundle
 * (SPA-155); only the server fn that wraps it stays in `server/notes.ts`.
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
