import type { noteKind } from '@spaces/db/schema'

/**
 * The one ordering rule for a lane of notes (SPA-104).
 *
 * A memo is a note with the flag up — presentation, never structure — and
 * what that presentation buys is the top of wherever the note is filed
 * (CONTEXT.md → The note model). That is a rule about a *lane*, not about
 * one page, so it lives here: the company lane sorts through this
 * comparator, and the person / deal / custom lanes of notes-1b reuse it
 * rather than each re-deriving "memos first, then recent".
 *
 * Deliberately not in SQL. `order by kind = 'memo' desc` would put the rule
 * in four query strings instead of one function, and none of them testable
 * without a database.
 */

export type NoteKind = (typeof noteKind.enumValues)[number]

/** The two fields the order is decided by, and nothing else. */
export type NoteOrder = {
  kind: NoteKind
  /** ISO 8601 — compared lexically, the repo convention for dates. */
  updatedAt: string
}

/** Memos first; inside each group, most recently updated first. */
export function byMemoThenRecent(a: NoteOrder, b: NoteOrder): number {
  const rank = (n: NoteOrder) => (n.kind === 'memo' ? 0 : 1)
  const kinds = rank(a) - rank(b)
  if (kinds !== 0) return kinds
  if (a.updatedAt === b.updatedAt) return 0
  return a.updatedAt > b.updatedAt ? -1 : 1
}
