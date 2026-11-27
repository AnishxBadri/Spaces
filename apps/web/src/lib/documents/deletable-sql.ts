import { sql } from 'drizzle-orm'
import { document, documentRevision, storageBinding } from '@spaces/db/schema'

/**
 * The two facts the delete confirm reads off a list row that the row does
 * not otherwise carry, as select fragments over `document`. The query must
 * join, so drizzle keeps the outer table's name on every column.
 */

/** Brought by a linked folder's sync, whose next poll will not bring it back. */
export const inSyncedFolderSql = sql<boolean>`exists (select 1 from ${storageBinding} where ${storageBinding.id} = ${document.bindingId} and ${storageBinding.grain} = 'folder')`

/** Its kept revisions and itself: what a delete takes with it. */
export const keptVersionsSql = sql<number>`(select count(*)::int + 1 from ${documentRevision} where ${documentRevision.documentId} = ${document.entityId})`
