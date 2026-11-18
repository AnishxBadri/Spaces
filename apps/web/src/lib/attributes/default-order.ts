import { SYSTEM_ATTRIBUTES } from '@spaces/core/attributes/registry'
import type { ObjectKind } from '@spaces/core/attributes/registry'

type Ordered = { id: string; slug: string; isSystem: boolean }

/**
 * A core object's attribute ids in the order a fresh install gives them:
 * the system attributes as `SYSTEM_ATTRIBUTES` lists them, then the custom
 * ones in the order `current` holds them. A system attribute the list no
 * longer names keeps its relative place after the listed ones.
 * - `current` is the object's whole registry in its present order, archived
 *   and derived halves included, so every row gets a place.
 */
export function defaultAttributeOrder(
  kind: ObjectKind,
  current: ReadonlyArray<Ordered>,
): Array<string> {
  const rank = new Map(SYSTEM_ATTRIBUTES[kind].map((d, i) => [d.slug, i]))
  const listed = current
    .flatMap((a) => {
      const at = a.isSystem ? rank.get(a.slug) : undefined
      return at === undefined ? [] : [{ id: a.id, at }]
    })
    .sort((a, b) => a.at - b.at)
  const unlisted = current.filter((a) => a.isSystem && !rank.has(a.slug))
  const custom = current.filter((a) => !a.isSystem)
  return [...listed, ...unlisted, ...custom].map((a) => a.id)
}
