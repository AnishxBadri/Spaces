import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entitySpace, link } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { Blocked } from '@spaces/core/writes/entities/delete'
import { deleteDocumentWithBlobGcProgram } from '#/lib/server/shared'
import { documentsQuery } from './query'

/**
 * `Delete…` on a file: the read gate, the delete, and a History line on
 * everything it was filed under.
 * - Outside the server-fn modules: the server fn is the session check, a
 *   test has no request, and their plain exports ship to the browser.
 * - Only someone who can read the file may delete it.
 * - The delete is `deleteDocumentWithBlobGcProgram`: the bytes, the text,
 *   the vectors, every revision and every filing go, a Drive file leaves its
 *   tombstone, and nothing is deleted at the provider.
 * - The History line names the record (or space) as its subject and keeps
 *   the file's name in `meta`, with no object: a line whose subject or
 *   object is the file is deleted with it.
 */

/** The file is private to someone else, so this reader may not delete it. */
export class DocumentDeleteRefused extends Schema.TaggedError<DocumentDeleteRefused>()(
  'DocumentDeleteRefused',
  { message: Schema.String },
) {}

/** The History verb a delete writes on each record and space. */
export const DOCUMENT_DELETED = 'document.deleted'

export const deleteDocumentProgram = Effect.fn('deleteDocumentProgram')(
  function* (userId: string, documentId: string) {
    const row = (yield* documentsQuery(() =>
      db
        .select({
          filename: document.filename,
          readable: sql<boolean>`${canReadDocumentSql(userId)}`,
        })
        .from(document)
        .where(eq(document.entityId, documentId)),
    )).at(0)
    // Already gone: the row leaving is the right answer, not an error.
    if (row === undefined) return { deleted: false }
    if (!row.readable)
      return yield* new DocumentDeleteRefused({
        message: 'Only someone who can read this file can delete it',
      })

    const records = yield* documentsQuery(() =>
      db
        .select({ id: link.toEntityId })
        .from(link)
        .where(
          and(
            eq(link.fromEntityId, documentId),
            eq(link.relation, 'tagged_in'),
          ),
        ),
    )
    const spaces = yield* documentsQuery(() =>
      db
        .select({ id: entitySpace.spaceId })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, documentId)),
    )

    yield* deleteDocumentWithBlobGcProgram(documentId)

    const subjects = [...new Set([...records, ...spaces].map((r) => r.id))]
    if (subjects.length === 0) return { deleted: true }
    const filename = row.filename ?? 'Untitled file'
    // After the commit, so a refused delete leaves no line. A line that fails
    // to write does not undo a delete that happened, so it is logged and the
    // delete still answers that it went.
    yield* documentsQuery(() =>
      db.insert(activity).values(
        subjects.map((id) => ({
          actorId: userId,
          verb: DOCUMENT_DELETED,
          subjectEntityId: id,
          meta: { filename },
        })),
      ),
    ).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          console.warn(
            `[documents] ${documentId} deleted; its History lines were not written`,
            failure,
          )
        }),
      ),
    )
    return { deleted: true }
  },
)

/** The sentence the client is shown: the refusal's own, else one of ours. */
export function deleteDocumentMessage(failure: unknown): string {
  if (failure instanceof DocumentDeleteRefused) return failure.message
  if (failure instanceof Blocked) return failure.reason
  return 'Could not delete this file'
}
