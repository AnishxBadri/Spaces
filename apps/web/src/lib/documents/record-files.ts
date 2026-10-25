import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, link } from '@spaces/db/schema'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'

/**
 * The documents filed on one record, as its Files tab lists them, newest
 * first. A document private to someone else is not listed.
 */
export function recordDocumentRows(viewerId: string, entityId: string) {
  return db
    .select({
      id: document.entityId,
      filename: document.filename,
      mime: document.mime,
      sizeBytes: document.sizeBytes,
      kind: document.kind,
      extractionStatus: document.extractionStatus,
      extractionError: document.extractionError,
      createdAt: document.createdAt,
      uploadedBy: document.uploadedBy,
      // Whether there are bytes at all. Null on a clipped
      // article — the page was read, never stored — and the row's controls
      // read it: a download that cannot exist is offered as "Open source"
      // instead, rather than as a button that throws when pressed.
      blobSha: document.blobSha,
      // The clip's own address, and the one column that tells a
      // saved article from a file: the row's pending state reads
      // "fetching…" rather than "extracting text…" when it is set.
      url: document.url,
      // The storage-source half of the row: where the provider's copy can
      // be opened, and whether it is still there. Both null on every
      // document until a storage-source plugin files one, and the row
      // renders nothing extra when they are.
      externalUrl: document.externalUrl,
      externalStatus: document.externalStatus,
      // The provider's own folder path, verbatim: the row's "from …" line.
      sourcePath: document.sourcePath,
      // The binding whose sync filed it: the Files tab puts it in that
      // folder's band. Null for everything else.
      bindingId: document.bindingId,
      // Enough text to prove extraction worked, without hauling a
      // 2MB column into every Files-tab render.
      snippet: sql<string | null>`left(${document.extractedText}, 200)`,
    })
    .from(link)
    .innerJoin(document, eq(document.entityId, link.fromEntityId))
    .innerJoin(entity, eq(entity.id, document.entityId))
    .where(
      and(
        eq(link.toEntityId, entityId),
        eq(link.relation, 'tagged_in'),
        isNull(entity.mergedIntoId),
        // A document private to someone else is not listed.
        canReadDocumentSql(viewerId),
      ),
    )
    .orderBy(desc(document.createdAt))
}
