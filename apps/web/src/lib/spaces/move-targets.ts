/** One row of the move window: a space, or the root, and whether it takes the move. */
export type MoveTarget = {
  /** null is the root. */
  id: string | null
  name: string
  depth: number
  /** Why the row is greyed; null when it takes the move. */
  refused: 'this space' | 'inside this space' | null
  /** The current parent: "now here", a move to it changes nothing. */
  current: boolean
}

type TreeRow = { id: string; name: string; path: string; depth: number }

function refusal(
  s: TreeRow,
  moving: { id: string; path: string },
): MoveTarget['refused'] {
  if (s.id === moving.id) return 'this space'
  if (s.path.startsWith(`${moving.path}.`)) return 'inside this space'
  return null
}

/**
 * The move window's rows, in tree order under a "Move to root" row: the
 * moving space and its descendants refused with the reason, its parent
 * marked current. (D73)
 */
export function moveTargets(
  tree: ReadonlyArray<TreeRow>,
  moving: { id: string; path: string; parentId: string | null },
): Array<MoveTarget> {
  const root: MoveTarget = {
    id: null,
    name: 'Move to root',
    depth: 0,
    refused: null,
    current: moving.parentId === null,
  }
  return [
    root,
    ...tree.map((s): MoveTarget => ({
      id: s.id,
      name: s.name,
      // The root row sits at depth 0, so the tree hangs one step under it.
      depth: s.depth + 1,
      refused: refusal(s, moving),
      current: s.id === moving.parentId,
    })),
  ]
}
