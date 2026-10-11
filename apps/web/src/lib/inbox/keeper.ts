/**
 * Which side of a duplicate pair a merge keeps by default — the richer one,
 * because a merge has no unmerge.
 * - Ranked by non-empty values, then spaces it is filed in, then mentions,
 *   then the older `createdAt`; a full tie keeps A.
 * - Pure: the review card calls it in the browser.
 */

/** What the ranking reads off one side of a pair. */
export type KeeperSide = {
  valueCount: number
  spaces: ReadonlyArray<string>
  mentionCount: number
  /** ISO 8601 — compared lexically, the repo convention for dates. */
  createdAt: string
}

/** How many of a record's values hold something: not null, `''` or `[]`. */
export function nonEmptyValueCount(values: Record<string, unknown>): number {
  let n = 0
  for (const v of Object.values(values)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    n += 1
  }
  return n
}

/** Positive when `a` is richer, negative when `b` is, 0 on a full tie. */
function compareRichness(a: KeeperSide, b: KeeperSide): number {
  return (
    a.valueCount - b.valueCount ||
    a.spaces.length - b.spaces.length ||
    a.mentionCount - b.mentionCount ||
    // Older wins: an earlier `createdAt` sorts first.
    (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
  )
}

/** The side a merge keeps unless the reviewer says otherwise. */
export function defaultKeeper(a: KeeperSide, b: KeeperSide): 'a' | 'b' {
  return compareRichness(a, b) < 0 ? 'b' : 'a'
}
