/**
 * The count column every inverse attribute brings to a list (D69): read-only,
 * sortable and filterable, never in `entity.values` as stored.
 * - Its slug is `count:<inverse slug>`; the colon keeps it apart from every
 *   attribute slug (`[a-z0-9_]`), as `stat:` does.
 * - Client-safe: the SQL half is `inverseCount` beside `entityValuesResolver`.
 */

const PREFIX = 'count:'

export const inverseCountSlug = (slug: string): `count:${string}` =>
  `${PREFIX}${slug}`

/** The inverse slug a `count:` slug counts, or null for any other slug. */
export const inverseCountOf = (slug: string): string | null =>
  slug.startsWith(PREFIX) ? slug.slice(PREFIX.length) : null

/** The count columns as filter-editor entries, appended like the stat filters. */
export function inverseCountFilters(
  inverses: ReadonlyArray<{ slug: string; name: string }>,
): Array<{
  slug: string
  name: string
  type: string
  options: null
  isSystem: boolean
}> {
  return inverses.map((d) => ({
    slug: inverseCountSlug(d.slug),
    name: `${d.name} count`,
    type: 'number',
    options: null,
    isSystem: true,
  }))
}
