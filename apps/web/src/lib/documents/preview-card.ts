import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'

/**
 * One document's card for `getDocumentPreview`, or null when it is gone,
 * merged away or private to someone else — the three answer alike.
 */
export async function documentPreviewCard(viewer: { id: string }, id: string) {
  // `.at(0)` rather than destructuring: the row genuinely may not exist —
  // a mention whose document was deleted is an ordinary state — and a
  // destructured element types as always-present.
  const row = (
    await db
      .select({
        id: document.entityId,
        filename: document.filename,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        kind: document.kind,
        extractionStatus: document.extractionStatus,
        extractionError: document.extractionError,
        // The two columns that decide whether there is a file to fetch at
        // all. A clipped article has no blob and an address
        // instead, and the dialog renders the extracted text with the
        // address linked rather than asking storage for bytes it never
        // stored — which is what `getDocumentDownloadUrl` throws about.
        blobSha: document.blobSha,
        url: document.url,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(document.entityId, id),
          // A private document opens for its author only.
          canReadDocumentSql(viewer.id),
        ),
      )
  ).at(0)
  if (!row || row.mergedIntoId) return null
  return {
    id: row.id,
    // Same coercion the Files tab makes: `filename` is nullable for
    // url-origin documents, and the dialog's title is not optional.
    filename: row.filename ?? 'Untitled file',
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    extractionStatus: row.extractionStatus,
    extractionError: row.extractionError,
    blobSha: row.blobSha,
    url: row.url,
  }
}
