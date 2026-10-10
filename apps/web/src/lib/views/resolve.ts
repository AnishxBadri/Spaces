import { sql } from 'drizzle-orm'
import { entity, interactionStat } from '@spaces/db/schema'
import { interactionStatField } from './stat-fields'
import type { SQL } from 'drizzle-orm'
import type { FieldResolver } from './sql'
import type { InteractionStatField } from './stat-fields'

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
 *
 * **The slug is a literal, not a bind parameter** (SPA-93). It used to be
 * `${slug}::text`, which drizzle sends as `$n` — and `values -> $n` is not
 * the same expression as the `values -> 'stage'::text` that
 * `attr_idx_<attribute id>` is built on, so the per-attribute index matched
 * only when the planner happened to fold the parameter in (an unnamed
 * statement's custom plan). A generic plan, a `PREPARE`, or a pooler that
 * names statements would have silently gone back to sorting the object, with
 * no error anywhere. The slug is not user input in the first place: it is
 * derived by `slugify` and immutable, `[a-z0-9_]` only. The quote-doubling
 * is belt and braces, not the argument.
 */
const slugLiteral = (slug: string) => `'${slug.replaceAll("'", "''")}'::text`

/**
 * A stat's timestamp for the listed row: a correlated lookup on
 * `interaction_stat`'s primary key `(entity_id, kind)`, the kind a literal.
 * SQL NULL when the record has no such interaction. (D67)
 */
export function interactionStatAt(f: InteractionStatField): SQL {
  const col =
    f.at === 'first'
      ? interactionStat.firstAt
      : f.at === 'last'
        ? interactionStat.lastAt
        : interactionStat.nextAt
  return sql`(select ${col} from ${interactionStat} where ${interactionStat.entityId} = ${entity.id} and ${interactionStat.kind} = ${sql.raw(`'${f.kind}'`)})`
}

/**
 * The resolver also answers the `stat:` slugs every entity list has: the UTC
 * day of the stat as a jsonb string, typed `date`, so `is`/`gt`/`lt` compare
 * days the way they do for a date attribute. Read-only — no write path takes
 * these slugs.
 */
export function entityValuesResolver(
  registry: Array<{ slug: string; type: string }>,
): FieldResolver {
  const typeOf = new Map(registry.map((d) => [d.slug, d.type]))
  return (slug) => {
    const stat = interactionStatField(slug)
    if (stat)
      return {
        expr: sql`to_jsonb(to_char(${interactionStatAt(stat)} at time zone 'UTC', 'YYYY-MM-DD'))`,
        type: 'date',
      }
    const type = typeOf.get(slug)
    if (type === undefined) return null
    return {
      expr: sql`(${entity.values} -> ${sql.raw(slugLiteral(slug))})`,
      type,
    }
  }
}
