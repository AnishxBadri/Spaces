import { Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import { attribute, objectDef } from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema'
import { coreKindOf } from '@spaces/core/attributes/registry'
import { relationsProgram } from '@spaces/core/writes/read/relations'
import type { RelationsQueryFailed } from '@spaces/core/writes/read/relations'
import { inverseCountSlug } from './inverse-fields'
import type { InverseSource, ResolverAttribute } from './resolve'

/**
 * An object's registry as a list resolves it, inverse halves included (D69).
 * - A derived half carries its owner's slug and object, so the compiler can
 *   read its links; one whose owner is archived or gone resolves to nothing
 *   and is left out of `live`, as `relationsProgram` drops it.
 * - Server-only: lives outside `lib/server/` so tests call it directly.
 */

export type LensAttribute = ResolverAttribute & { name: string }

export type LensRegistry = {
  /** Every attribute a condition, a sort or a column may name. */
  live: Array<LensAttribute>
  /** Archived attributes, by slug — they only name a reason. */
  archived: Array<{ slug: string; name: string }>
}

const owner = alias(attribute, 'owner')
const ownerObject = alias(objectDef, 'owner_object')

export async function lensRegistry(objectId: string): Promise<LensRegistry> {
  const rows = await db
    .select({
      slug: attribute.slug,
      name: attribute.name,
      type: attribute.type,
      archived: attribute.archived,
      options: attribute.options,
      ownerSlug: owner.slug,
      ownerArchived: owner.archived,
      ownerObjectId: ownerObject.id,
      ownerObjectSlug: ownerObject.slug,
      ownerObjectSystem: ownerObject.isSystem,
    })
    .from(attribute)
    .leftJoin(
      owner,
      sql`${attribute.options}->>'derived' = 'true' and ${owner.id}::text = ${attribute.options}->>'inverseOf'`,
    )
    .leftJoin(ownerObject, eq(ownerObject.id, owner.objectId))
    .where(eq(attribute.objectId, objectId))

  const live: Array<LensAttribute> = []
  const archived: Array<{ slug: string; name: string }> = []
  for (const r of rows) {
    if (r.archived) {
      archived.push({ slug: r.slug, name: r.name })
      continue
    }
    const plain = { slug: r.slug, name: r.name, type: r.type }
    if (!(r.type === 'record_reference' && r.options.derived === true)) {
      live.push(plain)
      continue
    }
    if (
      r.ownerSlug === null ||
      r.ownerArchived !== false ||
      r.ownerObjectId === null ||
      r.ownerObjectSlug === null ||
      r.ownerObjectSystem === null
    )
      continue
    const kind = coreKindOf({
      slug: r.ownerObjectSlug,
      isSystem: r.ownerObjectSystem,
    })
    live.push({
      ...plain,
      inverse: {
        linkSlug: r.ownerSlug,
        from: kind === null ? { objectId: r.ownerObjectId } : { kind },
        multi: r.options.multi === true,
      },
    })
  }
  return { live, archived }
}

/** The inverse halves of a resolved registry, for `withInverseValues`. */
export const inversesOf = (
  registry: ReadonlyArray<ResolverAttribute>,
): Array<{ slug: string; inverse: InverseSource }> =>
  registry.flatMap((a) =>
    a.inverse ? [{ slug: a.slug, inverse: a.inverse }] : [],
  )

/**
 * A page's rows with each inverse filled from `relationsProgram`, and its
 * count under `count:<slug>` — so the browser evaluator reads exactly what
 * the SQL compares, and a cell writes the inverse back as if it were stored.
 * Names for the far records come back for the cells.
 */
export const withInverseValues = Effect.fn('withInverseValues')(function* <
  TRow extends { id: string; values: EntityValues },
>(
  rows: Array<TRow>,
  inverses: ReadonlyArray<{ slug: string; inverse: InverseSource }>,
): Effect.fn.Return<
  { rows: Array<TRow>; refNames: Record<string, { name: string }> },
  RelationsQueryFailed
> {
  if (inverses.length === 0 || rows.length === 0) return { rows, refNames: {} }
  const halves = yield* relationsProgram(rows.map((r) => r.id))
  const refNames: Record<string, { name: string }> = {}
  const filled = rows.map((r) => {
    const values: EntityValues = { ...r.values }
    for (const inv of inverses) {
      const half = halves
        .get(r.id)
        ?.find((h) => h.derived && h.slug === inv.slug)
      for (const item of half?.items ?? [])
        refNames[item.id] = { name: item.name }
      values[inv.slug] = half?.value ?? (inv.inverse.multi ? [] : null)
      values[inverseCountSlug(inv.slug)] = half?.items.length ?? 0
    }
    return { ...r, values }
  })
  return { rows: filled, refNames }
})
