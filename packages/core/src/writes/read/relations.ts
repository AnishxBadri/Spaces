import { Effect, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, link, objectDef } from '@spaces/db/schema'
import type { Json } from '@spaces/db/json'
import { CORE_OBJECTS, OBJECT_KINDS } from '../../attributes/registry'

/**
 * The inverse resolver (D69): both halves of every relationship a record
 * sits on, read from the `references` links `setValues` writes.
 * - The derived half is the links pointing at the record (`link_to_idx`)
 *   whose owner attribute names it in `options.inverseOf`; nothing is stored
 *   on the record itself.
 * - The owning half is the record's own outgoing links of a paired
 *   attribute, in the order its value holds them.
 * - One statement for any number of records, never one per attribute.
 * - A derived half whose owner is archived resolves to nothing.
 */

export class RelationsQueryFailed extends Schema.TaggedError<RelationsQueryFailed>()(
  'RelationsQueryFailed',
  { cause: Schema.Defect() },
) {}

/** A record on the far side of a relationship. */
export type RelationItem = {
  id: string
  name: string
  kind: string
  /** The far record's object slug, for its path; null for a research kind. */
  objectSlug: string | null
}

/** One attribute of a relationship, as one record reads it. */
export type RelationHalf = {
  /** The attribute's slug on this record's object. */
  slug: string
  name: string
  /** The inverse half: stores nothing, read from the owner's links. */
  derived: boolean
  /** The slug the `references` links carry — the owner's. */
  linkSlug: string
  /** As the attribute holds it: a list when `multi`, else one id or null. */
  value: Json
  items: Array<RelationItem>
}

type Row = {
  record_id: string
  slug: string
  name: string
  derived: boolean
  multi: boolean
  link_slug: string
  item_id: string
  item_name: string
  item_kind: string
  item_object_slug: string | null
}

/** An entity's object id: its row, or a core kind born without one. */
const objectOf = (alias: string): SQL => {
  const e = sql.raw(alias)
  const slugOfKind = sql.join(
    OBJECT_KINDS.map((k) => sql`when ${k} then ${CORE_OBJECTS[k].slug}`),
    sql` `,
  )
  return sql`coalesce(${e}.object_id, (select o.id from ${objectDef} o where o.is_system and o.slug = (case ${e}.kind::text ${slugOfKind} end)))`
}

const statement = (ids: ReadonlyArray<string>): SQL => sql`
  with ids as (select unnest(${`{${ids.join(',')}}`}::uuid[]) as id)
  select
    l.to_entity_id as record_id,
    inv.slug, inv.name, true as derived,
    coalesce((inv.options->>'multi')::boolean, false) as multi,
    own.slug as link_slug,
    src.id as item_id, src.canonical_name as item_name,
    src.kind::text as item_kind, so.slug as item_object_slug,
    0::bigint as pos
  from ${link} l
  join ${entity} src on src.id = l.from_entity_id and src.merged_into_id is null
  join ${objectDef} so on so.id = ${objectOf('src')}
  join ${attribute} own
    on own.object_id = so.id and own.slug = l.attr_slug and not own.archived
  join ${attribute} inv
    on inv.id::text = own.options->>'inverseOf'
    and not inv.archived and inv.options->>'derived' = 'true'
  join ${entity} tgt on tgt.id = l.to_entity_id
  where l.relation = 'references'
    and l.to_entity_id in (select id from ids)
    and inv.object_id = ${objectOf('tgt')}
  union all
  select
    l.from_entity_id,
    own.slug, own.name, false,
    coalesce((own.options->>'multi')::boolean, false),
    own.slug,
    dst.id, dst.canonical_name, dst.kind::text, dob.slug,
    coalesce((
      select t.ord from jsonb_array_elements_text(
        case jsonb_typeof(src.values -> own.slug)
          when 'array' then src.values -> own.slug
          else jsonb_build_array(src.values -> own.slug)
        end
      ) with ordinality as t(v, ord)
      where t.v = dst.id::text
      limit 1
    ), 0)
  from ${link} l
  join ${entity} src on src.id = l.from_entity_id
  join ${attribute} own
    on own.object_id = ${objectOf('src')} and own.slug = l.attr_slug
    and not own.archived and own.options ? 'inverseOf'
    and coalesce(own.options->>'derived', '') <> 'true'
  join ${entity} dst on dst.id = l.to_entity_id and dst.merged_into_id is null
  left join ${objectDef} dob on dob.id = ${objectOf('dst')}
  where l.relation = 'references'
    and l.from_entity_id in (select id from ids)
  order by record_id, derived, slug, pos, item_name, item_id
`

/**
 * Every relationship half the given records hold an item on, by record id.
 * A record with none is absent; a half with no items is absent, so a
 * surface pairs these with its registry to draw the empty ones.
 */
export const relationsProgram = Effect.fn('relationsProgram')(function* (
  ids: ReadonlyArray<string>,
): Effect.fn.Return<Map<string, Array<RelationHalf>>, RelationsQueryFailed> {
  const out = new Map<string, Array<RelationHalf>>()
  if (ids.length === 0) return out
  const rows = yield* Effect.tryPromise({
    try: () => db.execute<Row>(statement([...new Set(ids)])),
    catch: (cause) => new RelationsQueryFailed({ cause }),
  })
  const multiOf = new Map<RelationHalf, boolean>()
  for (const r of rows.rows) {
    const halves = out.get(r.record_id) ?? []
    if (!out.has(r.record_id)) out.set(r.record_id, halves)
    let half = halves.find((h) => h.slug === r.slug && h.derived === r.derived)
    if (!half) {
      half = {
        slug: r.slug,
        name: r.name,
        derived: r.derived,
        linkSlug: r.link_slug,
        value: null,
        items: [],
      }
      multiOf.set(half, r.multi)
      halves.push(half)
    }
    if (half.items.some((i) => i.id === r.item_id)) continue
    half.items.push({
      id: r.item_id,
      name: r.item_name,
      kind: r.item_kind,
      objectSlug: r.item_object_slug,
    })
  }
  for (const [half, multi] of multiOf) {
    const held = half.items.map((i) => i.id)
    half.value = multi ? held : (held.at(0) ?? null)
  }
  return out
})

/** One record's halves — `relationsProgram` for a single id. */
export const recordRelationsProgram = Effect.fn('recordRelationsProgram')(
  function* (
    id: string,
  ): Effect.fn.Return<Array<RelationHalf>, RelationsQueryFailed> {
    return (yield* relationsProgram([id])).get(id) ?? []
  },
)

/** id → name for every far record, for reference cells. */
export function relationNames(
  halves: ReadonlyArray<RelationHalf>,
): Record<string, { name: string }> {
  return Object.fromEntries(
    halves.flatMap((h) => h.items.map((i) => [i.id, { name: i.name }])),
  )
}
