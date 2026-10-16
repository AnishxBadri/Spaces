/**
 * canRead, as a predicate: shared unless private-and-not-yours.
 * - Applies to notes and documents alike; `row` is either one's
 *   `visibility` and `author_id`. A private row with no author is nobody's.
 * - The SQL twins are `canReadNoteSql` and `canReadDocumentSql`; the shared
 *   table-driven test holds the three to one answer.
 * - Pure, so every read path outside `lib/server/` can import it.
 */
export function canRead(
  user: { id: string },
  row: { visibility?: string | null; authorId?: string | null },
): boolean {
  if (row.visibility !== 'private') return true
  return row.authorId === user.id
}
