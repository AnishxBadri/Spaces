/**
 * canRead, as a predicate: shared unless private-and-not-yours.
 * - Applies to notes and documents alike; `row` is either one's
 *   `visibility` and `author_id`. A private row with no author is nobody's.
 * - `widened`: the row is a synced email's body or attachment its owner
 *   opened to this reader — a record override or a grant. The caller
 *   resolves it for the same reader with `noteWidenedSql` /
 *   `documentWidenedSql`; omitted, a private row stays its author's.
 * - The SQL twins are `canReadNoteSql` and `canReadDocumentSql`; the shared
 *   table-driven test holds the three to one answer.
 * - Pure, so any read path, client or server, can import it.
 */
export function canRead(
  user: { id: string },
  row: {
    visibility?: string | null
    authorId?: string | null
    widened?: boolean
  },
): boolean {
  if (row.visibility !== 'private') return true
  if (row.authorId === user.id) return true
  return row.widened === true
}
