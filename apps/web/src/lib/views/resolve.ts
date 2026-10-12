import { sql } from 'drizzle-orm'
import { entity, interactionStat, link } from '@spaces/db/schema'
import type { ObjectKind } from '@spaces/core/attributes/registry'
import { interactionStatField } from './stat-fields'
import { inverseCountOf } from './inverse-fields'
import type { SQL } from 'drizzle-orm'
import type { FieldResolver, ResolvedField } from './sql'
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
export function interactionStatAt(
  f: Pick<InteractionStatField, 'kind' | 'at'>,
): SQL {
  const col =
    f.at === 'first'
      ? interactionStat.firstAt
      : f.at === 'last'
        ? interactionStat.lastAt
        : interactionStat.nextAt
  return sql`(select ${col} from ${interactionStat} where ${interactionStat.entityId} = ${entity.id} and ${interactionStat.kind} = ${sql.raw(`'${f.kind}'`)})`
}

/** A stat as a condition reads it: its UTC day as a jsonb string. */
export const interactionStatDay = (
  f: Pick<InteractionStatField, 'kind' | 'at'>,
): SQL =>
  sql`to_jsonb(to_char(${interactionStatAt(f)} at time zone 'UTC', 'YYYY-MM-DD'))`

/**
 * Where an inverse attribute's value lives (D69): the `references` links
 * its owner writes, pointing at the listed row.
 */
export type InverseSource = {
  /** The owner's slug, which `link.attr_slug` carries. */
  linkSlug: string
  /** The owner's object — its records are the links' only valid sources. */
  from: { kind: ObjectKind } | { objectId: string }
  /** The inverse holds a list; otherwise its first record or null. */
  multi: boolean
}

/** A registry row as the resolver reads it; `inverse` only on a derived half. */
export type ResolverAttribute = {
  slug: string
  type: string
  inverse?: InverseSource
}

/**
 * The listed row's live inbound links of one owner, as a `from … where`
 * tail aliased `l` (link) and `s` (the source record).
 * - `l.to_entity_id = entity.id, l.attr_slug = '<owner>'` is what
 *   `attr_idx_links` is built on; the slug is a literal for the reason
 *   `slugLiteral` is.
 * - The source is restricted to the owner's object, so another object's
 *   same-slug reference never counts, and to unmerged records, as
 *   `relationsProgram` reads them.
 */
function inbound(src: InverseSource, extra?: SQL): SQL {
  const from =
    'kind' in src.from
      ? sql`s.kind = ${sql.raw(`'${src.from.kind}'`)}`
      : sql`s.kind = 'custom' and s.object_id = ${src.from.objectId}::uuid`
  return sql`from ${link} l join ${entity} s on s.id = l.from_entity_id
    where l.to_entity_id = ${entity.id}
      and l.attr_slug = ${sql.raw(slugLiteral(src.linkSlug))}
      and l.relation = 'references'
      and s.merged_into_id is null
      and ${from}${extra ? sql` and ${extra}` : sql``}`
}

/** The inverse's resolved value as jsonb, in `relationsProgram`'s order. */
const inverseValue = (src: InverseSource): SQL =>
  src.multi
    ? sql`coalesce((select jsonb_agg(s.id::text order by s.canonical_name, s.id) ${inbound(src)}), '[]'::jsonb)`
    : sql`(select to_jsonb(s.id::text) ${inbound(src)} order by s.canonical_name, s.id limit 1)`

/** How many records the inverse holds — a correlated count. */
export const inverseCount = (src: InverseSource): SQL =>
  sql`(select count(*) ${inbound(src)})`

/**
 * An inverse attribute as the compiler takes it: membership as an `exists`
 * over its links, the value itself for every other op, and the first
 * referenced name as its sort key.
 */
export function inverseField(src: InverseSource): ResolvedField {
  return {
    expr: inverseValue(src),
    type: 'record_reference',
    inverse: {
      exists: (member) =>
        sql`exists (select 1 ${inbound(src, member === null ? undefined : sql`l.from_entity_id::text = ${member}`)})`,
      firstName: sql`(select s.canonical_name ${inbound(src)} order by s.canonical_name, s.id limit 1)`,
    },
  }
}

/**
 * The resolver also answers `count:<slug>` for an inverse attribute: its
 * count as a jsonb number, typed `number`. Read-only, like `stat:`.
 *
 * The resolver also answers the `stat:` slugs every entity list has: the UTC
 * day of the stat as a jsonb string, typed `date`, so `is`/`gt`/`lt` compare
 * days the way they do for a date attribute. Read-only — no write path takes
 * these slugs.
 */
export function entityValuesResolver(
  registry: ReadonlyArray<ResolverAttribute>,
): FieldResolver {
  const bySlug = new Map(registry.map((d) => [d.slug, d]))
  return (slug) => {
    const stat = interactionStatField(slug)
    if (stat) return { expr: interactionStatDay(stat), type: 'date' }
    const counted = inverseCountOf(slug)
    if (counted !== null) {
      const src = bySlug.get(counted)?.inverse
      return src
        ? { expr: sql`to_jsonb(${inverseCount(src)})`, type: 'number' }
        : null
    }
    const def = bySlug.get(slug)
    if (def === undefined) return null
    if (def.inverse) return inverseField(def.inverse)
    const type = def.type
    return {
      expr: sql`(${entity.values} -> ${sql.raw(slugLiteral(slug))})`,
      type,
    }
  }
}
