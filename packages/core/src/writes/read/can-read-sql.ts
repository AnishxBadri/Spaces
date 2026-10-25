import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

/**
 * The outer query's document id, spelled qualified: drizzle drops the table
 * name in a one-table select, and an unqualified `entity_id` would bind to a
 * table inside the predicate.
 */
export const DOCUMENT_ID_REF: SQL = sql`"document"."entity_id"`

/**
 * The owner's override covers this email: the owner opened their emails with
 * a record the email is on to the workspace — on a deal, the threads it
 * derives from its company and contacts too.
 * - `interactionId` and `ownerId` are expressions in the outer query; the
 *   owner is the body's or the attachment's author.
 */
export const emailOpenedToWorkspaceSql = (
  interactionId: SQL,
  ownerId: SQL,
): SQL<boolean> => sql<boolean>`exists (
            select 1 from email_visibility wv
            join interaction_entity wie on wie.interaction_id = ${interactionId}
            where wv.user_id = ${ownerId}
              and wv.scope = 'workspace'
              and (wv.entity_id = wie.entity_id or exists (
                select 1 from link wl
                join entity wd on wd.id = wl.from_entity_id and wd.kind = 'deal'
                where wl.from_entity_id = wv.entity_id
                  and wl.relation = 'references'
                  and wl.attr_slug in ('company', 'people')
                  and wl.to_entity_id = wie.entity_id
              ))
          )`

/** An email opened past its owner to `userId`: a grant to them or the override. */
const emailWidenedSql = (
  userId: string,
  interactionId: SQL,
  ownerId: SQL,
): SQL => sql`(exists (
            select 1 from email_grant wg
            where wg.interaction_id = ${interactionId}
              and wg.user_id = ${userId}
          ) or ${emailOpenedToWorkspaceSql(interactionId, ownerId)})`

/**
 * The ids of every email body opened to `userId` past its owner. Uncorrelated,
 * so Postgres computes it once per statement and the outer anti-join keeps
 * the views' index scans.
 */
const widenedNoteIdsSql = (userId: string): SQL => sql`array(
            select wi.note_id from interaction wi
            join note wn on wn.entity_id = wi.note_id
            where wi.kind = 'email'
              and ${emailWidenedSql(userId, sql`wi.id`, sql`wn.author_id`)}
          )`

/** The ids of every email attachment opened to `userId`; as `widenedNoteIdsSql`. */
const widenedDocumentIdsSql = (userId: string): SQL => sql`array(
            select wad.document_id from interaction_document wad
            join interaction wai on wai.id = wad.interaction_id
            join document wdd on wdd.entity_id = wad.document_id
            where wad.role = 'attachment'
              and wai.kind = 'email'
              and ${emailWidenedSql(userId, sql`wai.id`, sql`wdd.author_id`)}
          )`

/**
 * True when the note row `as` (a table name or alias) is a synced email's
 * body opened to `userId` by its owner. Select it beside `visibility` and
 * `author_id` to hand `canRead` its `widened`.
 */
export const noteWidenedSql = (userId: string, as = 'note'): SQL<boolean> =>
  sql<boolean>`(${sql.identifier(as)}.entity_id = any(${widenedNoteIdsSql(userId)}))`

/**
 * True when the document row `as` is an attachment of a synced email its
 * owner opened to `userId`. The `canRead` input `noteWidenedSql` is for notes.
 */
export const documentWidenedSql = (
  userId: string,
  as = 'document',
): SQL<boolean> =>
  sql<boolean>`(${sql.identifier(as)}.entity_id = any(${widenedDocumentIdsSql(userId)}))`

/**
 * canRead over one document, in SQL: true unless it is private to someone
 * other than `userId` and not opened to them — a synced email's attachment
 * is private to its mailbox owner until a grant or the override widens it.
 * - `documentId` is an expression in the outer query: `DOCUMENT_ID_REF` by
 *   default, `e.id` inside `canReadNoteSql`.
 * - `is distinct from`, so a private row with no author reads as nobody's,
 *   exactly as `canRead` answers it.
 */
export const canReadDocumentSql = (
  userId: string,
  documentId: SQL = DOCUMENT_ID_REF,
): SQL => sql`not exists (
            select 1 from document pd
            where pd.entity_id = ${documentId}
              and pd.visibility = 'private'
              and pd.author_id is distinct from ${userId}
              and not ${documentWidenedSql(userId, 'pd')}
          )`

/**
 * canRead as a predicate over the entity aliased `e`: true unless `e` is a
 * note or a document private to someone other than `userId` and not opened
 * to them.
 * - Vacuous for every other kind, which is what lets the name lane apply it
 *   to companies and decks alike; in the note lane `e` is the note itself.
 */
export const canReadNoteSql = (userId: string): SQL => sql`not exists (
            select 1 from note pn
            where pn.entity_id = e.id
              and pn.visibility = 'private'
              and pn.author_id <> ${userId}
              and not ${noteWidenedSql(userId, 'pn')}
          ) and ${canReadDocumentSql(userId, sql`e.id`)}`
