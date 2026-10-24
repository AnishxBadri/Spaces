import { and, eq, notExists, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entitySpace, link } from '@spaces/db/schema'

/**
 * Unfiled: a document carrying **no filing edge of either kind**. A derived
 * state: never `source_class`, never `blob_sha`, so an integration-filed row
 * or a blobless clip with no edges is unfiled too.
 * - Two `NOT EXISTS`, not an anti-join: a single anti-join over both edge
 *   tables would let a document with one edge kind read as unfiled.
 * - The one definition: the shelf's filter and Today's count both call it,
 *   so the count never disagrees with the list it links to.
 * - Correlates against the bare `document` table; both callers select it
 *   unaliased.
 */
export function unfiledPredicate(): SQL {
  const noRecord = notExists(
    db
      .select({ one: sql`1` })
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, document.entityId),
          eq(link.relation, 'tagged_in'),
        ),
      ),
  )
  const noSpace = notExists(
    db
      .select({ one: sql`1` })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, document.entityId)),
  )
  return sql`${noRecord} and ${noSpace}`
}
