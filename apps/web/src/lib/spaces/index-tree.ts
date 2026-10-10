/**
 * How the market map draws its tree, from rows in path order.
 * - `mark`: `├` when a later sibling follows, `└` on the last child, none
 *   on a top-level row.
 * - `groupEnd`: the last row of a top-level group — the only row ruled.
 */
export type TreeMark = '├' | '└' | null

export function treeRows<
  TRow extends { id: string; parentId: string | null; depth: number },
>(
  rows: ReadonlyArray<TRow>,
): Array<TRow & { mark: TreeMark; groupEnd: boolean }> {
  const lastChild = new Map<string, string>()
  for (const r of rows) {
    if (r.parentId !== null) lastChild.set(r.parentId, r.id)
  }
  return rows.map((r, i) => {
    const next = rows.at(i + 1)
    return {
      ...r,
      mark:
        r.depth === 0 || r.parentId === null
          ? null
          : lastChild.get(r.parentId) === r.id
            ? '└'
            : '├',
      groupEnd: next === undefined || next.depth === 0,
    }
  })
}

/** Each space's path of names, `Proptech / Property ops`, for the picker. */
export function spacePaths(
  rows: ReadonlyArray<{ id: string; name: string; parentId: string | null }>,
): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const paths = new Map<string, string>()
  const pathOf = (id: string): string => {
    const known = paths.get(id)
    if (known !== undefined) return known
    const row = byId.get(id)
    if (!row) return ''
    const above = row.parentId === null ? '' : pathOf(row.parentId)
    const path = above === '' ? row.name : `${above} / ${row.name}`
    paths.set(id, path)
    return path
  }
  for (const r of rows) pathOf(r.id)
  return paths
}
