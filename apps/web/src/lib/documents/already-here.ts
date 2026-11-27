import { Effect } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { documentFilingEdgesProgram } from '#/lib/server/shared'
import { documentsQuery } from './query'

/** A file whose bytes match a file being added, as its `Already here` row names it. */
export type StoredDocument = {
  readonly id: string
  readonly filename: string
  /** The first record or space it is filed under; null while unfiled. */
  readonly under: string | null
}

/**
 * The file the reader may read whose bytes are `sha`, the oldest when
 * several are; null when there is none.
 * - Content, not name: `blob_sha` is the content address, so a renamed copy
 *   is found and a different file with the same name is not.
 * - Only a file the reader may read counts. Someone else's private file with
 *   the same bytes answers null, so a hash never says that file exists; the
 *   reader's own copy then lands as its own row on the shared blob.
 */
export const alreadyHereProgram = Effect.fn('alreadyHere')(function* (
  viewer: { readonly id: string },
  sha: string,
) {
  const found = (yield* documentsQuery(() =>
    db
      .select({
        id: document.entityId,
        filename: document.filename,
        name: entity.canonicalName,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(document.blobSha, sha),
          isNull(entity.mergedIntoId),
          canReadDocumentSql(viewer.id),
        ),
      )
      .orderBy(asc(document.createdAt))
      .limit(1),
  )).at(0)
  if (found === undefined) return null
  const edges = yield* documentFilingEdgesProgram([found.id])
  const stored: StoredDocument = {
    id: found.id,
    // A row with no filename of its own is named as its entity is.
    filename: found.filename ?? found.name,
    under: edges.get(found.id)?.at(0)?.name ?? null,
  }
  return stored
})
