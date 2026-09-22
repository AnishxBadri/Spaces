import { and, eq, notExists, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entitySpace, link } from '@spaces/db/schema'

/**
 * Unfiled: a document carrying **no filing edge of either kind** (SPA-124,
 * `docs/spec-storage-sources.md` §3.2, §11 delta 6).
 *
 * It is a derived state, not a column and not an origin. Bytes can now arrive
 * with no target down several lanes — global upload, a URL clip, a plugin
 * that found no match, email and Drive later — and what makes an arrival
 * unfiled is the absence of edges, never `source_class` and never
 * `blob_sha`. An integration-filed row with no edges is as unfiled as a
 * drag-and-drop, and a blobless clip is too.
 *
 * ## Why two `NOT EXISTS` and not an anti-join
 *
 * Filing is two mechanisms that are never mixed (CONTEXT.md → _Sources are
 * documents_): `link(tagged_in)` files a document against a record,
 * `entity_space` files it into a space. A `left join … where null` over both
 * would have to be two anti-joins anyway, and a document carrying **one** of
 * the two edge kinds would survive the other's null test — it would read as
 * unfiled while sitting on a company's Files tab. Two correlated
 * subqueries ask the only question that is actually being asked, once each,
 * and Postgres answers each with an index-only semi-join probe that stops at
 * the first row rather than materialising the edges.
 *
 * ## Why one helper
 *
 * The shelf's filter and Today's badge are the same claim about the same
 * rows, and a count that disagreed with the list it links to is the failure
 * mode this file exists to prevent. Both `listDocumentsProgram` and
 * `countUnfiledProgram` (`#/lib/documents/shelf`) call this; neither restates
 * it.
 *
 * The fragment correlates against the bare `document` table rather than an
 * alias because both callers select from it unaliased — a parameter for an
 * alias nobody has would be a knob with no hand on it. If a third caller ever
 * needs the alias, it takes a column here and the two existing callers pass
 * `document.entityId`.
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
