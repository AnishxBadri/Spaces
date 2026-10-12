import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

/**
 * The outer query's document id, spelled qualified: drizzle drops the table
 * name in a one-table select, and an unqualified `entity_id` would bind to a
 * table inside the predicate.
 */
export const DOCUMENT_ID_REF: SQL = sql`"document"."entity_id"`

/**
 * True when a document is an email attachment `userId` may not see: private
 * with its email's body (D67).
 * - Hidden only while **every** way it reached the workspace is a mail filing
 *   the reader cannot read. Any other arrival makes it visible: a birth by
 *   another lane or a person, a person's filing edge, a `document.arrived`
 *   row from another lane or a person (a dedupe that wrote no edge), or an
 *   attaching email the reader can read.
 * - A mail filing is one by an integration that is the `source_ref` of one
 *   of the document's attaching emails.
 * - `documentId` is an SQL expression in the outer query: `e.id`, or
 *   `DOCUMENT_ID_REF`. Inner aliases all start with `a`.
 */
export const attachmentHiddenSql = (userId: string, documentId: SQL): SQL => {
  const mailLanes = sql`(
    select ai.source_ref from interaction_document ad
    join interaction ai on ai.id = ad.interaction_id
    where ad.document_id = ${documentId} and ad.role = 'attachment'
      and ai.source_ref is not null
  )`
  return sql`(
    exists (
      select 1 from interaction_document ad
      where ad.document_id = ${documentId} and ad.role = 'attachment'
    )
    and not exists (
      select 1 from interaction_document ad
      join interaction ai on ai.id = ad.interaction_id
      left join note an on an.entity_id = ai.note_id
      where ad.document_id = ${documentId} and ad.role = 'attachment'
        and (an.visibility is distinct from 'private' or an.author_id = ${userId})
    )
    and not exists (
      select 1 from document ab
      where ab.entity_id = ${documentId}
        and (ab.source_ref is null or ab.source_ref not in ${mailLanes})
    )
    and not exists (
      select 1 from link al
      where al.from_entity_id = ${documentId} and al.relation = 'tagged_in'
        and al.created_by is not null
    )
    and not exists (
      select 1 from entity_space ae
      where ae.entity_id = ${documentId} and ae.created_by is not null
    )
    and not exists (
      select 1 from activity aa
      where aa.subject_entity_id = ${documentId} and aa.verb = 'document.arrived'
        and (
          aa.actor_id is not null
          or coalesce(aa.meta ->> 'integrationId', '') not in (
            select l.source_ref::text from ${mailLanes} as l(source_ref)
          )
        )
    )
  )`
}
