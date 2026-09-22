import { sql } from 'drizzle-orm'
import { entity } from '@spaces/db/schema'
import type { FieldResolver } from './sql'

/**
 * The entity-backed half of the compiler's seam (SPA-40). Every
 * registry-generated list stores its fields in one `values` jsonb column, so
 * one resolver serves all of them: a slug becomes `values -> 'slug'` and the
 * type comes from the registry row.
 *
 * A slug the registry does not carry — never declared, or archived and so
 * absent from the live registry read — resolves to null, and
 * `compileConditions` drops that condition. A stale saved view therefore
 * widens rather than empties, which is what `matchesConditions` already does
 * when `typeOf` returns undefined.
 *
 * `-> `, not `->>`: the compiler wants the jsonb value so an array stays an
 * array and a missing key stays distinguishable from `''`. See `sql.ts`.
 */
export function entityValuesResolver(
  registry: Array<{ slug: string; type: string }>,
): FieldResolver {
  const typeOf = new Map(registry.map((d) => [d.slug, d.type]))
  return (slug) => {
    const type = typeOf.get(slug)
    if (type === undefined) return null
    return { expr: sql`(${entity.values} -> ${slug}::text)`, type }
  }
}
