import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

/**
 * The outer query's document id, spelled qualified: drizzle drops the table
 * name in a one-table select, and an unqualified `entity_id` would bind to a
 * table inside the predicate.
 */
export const DOCUMENT_ID_REF: SQL = sql`"document"."entity_id"`

/**
 * canRead over one document, in SQL: true unless it is private to someone
 * other than `userId` — a synced email's attachment is private to its
 * mailbox owner (D67).
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
          )`

/**
 * canRead as a predicate over the entity aliased `e`: true unless `e` is a
 * note or a document private to someone other than `userId`.
 * - Vacuous for every other kind, which is what lets the name lane apply it
 *   to companies and decks alike; in the note lane `e` is the note itself.
 */
export const canReadNoteSql = (userId: string): SQL => sql`not exists (
            select 1 from note pn
            where pn.entity_id = e.id
              and pn.visibility = 'private'
              and pn.author_id <> ${userId}
          ) and ${canReadDocumentSql(userId, sql`e.id`)}`
