import type { noteKind } from '@spaces/db/schema'

/**
 * The one ordering rule for a lane of notes: memos first, then recent. Every
 * lane (record pages, spaces) sorts through it.
 * Not in SQL: `order by kind = 'memo' desc` would repeat the rule in every
 * query, none testable without a database.
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
