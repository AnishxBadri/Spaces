import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, objectDef } from '@spaces/db/schema'
import {
  CORE_OBJECTS,
  OBJECT_KINDS,
  SYSTEM_ATTRIBUTES,
} from '../../attributes/registry'
import type { ObjectKind } from '../../attributes/registry'

/**
 * Idempotent system seed — runs on every boot (after migrations). Inserts
 * what's missing; never overwrites existing rows, because nouns and options
 * are user-editable content after first boot. New system objects/attributes
 * added in a release appear on upgrade without stomping user edits.
 */
export async function seedSystemAttributes() {
  const objectIds = new Map<ObjectKind, string>()
  let insertedObjects = 0
  for (const kind of OBJECT_KINDS) {
    const def = CORE_OBJECTS[kind]
    const existing = (
      await db
        .select({ id: objectDef.id })
        .from(objectDef)
        .where(eq(objectDef.slug, def.slug))
        .limit(1)
    ).at(0)
    if (existing) {
      objectIds.set(kind, existing.id)
      continue
    }
    const [row] = await db
      .insert(objectDef)
      .values({
        slug: def.slug,
        singular: def.singular,
        plural: def.plural,
        isSystem: true,
      })
      .returning({ id: objectDef.id })
    objectIds.set(kind, row.id)
    insertedObjects++
  }
  if (insertedObjects > 0)
    console.log(`[attributes] seeded ${insertedObjects} system objects`)

  let inserted = 0
  for (const objectKind of OBJECT_KINDS) {
    const objectId = objectIds.get(objectKind)!
    const defs = SYSTEM_ATTRIBUTES[objectKind]
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]
      const existing = await db
        .select({ id: attribute.id })
        .from(attribute)
        .where(
          and(eq(attribute.objectId, objectId), eq(attribute.slug, def.slug)),
        )
        .limit(1)
      if (existing.length > 0) continue
      await db.insert(attribute).values({
        objectId,
        slug: def.slug,
        name: def.name,
        type: def.type,
        options: def.options ?? {},
        // Engine flags (SPA-93). Seeded, never re-asserted: like options and
        // names, they are user-editable content after first boot, so an
        // operator who unticks the box on `stage` keeps it unticked across
        // upgrades.
        filterable: def.filterable ?? false,
        sortable: def.sortable ?? false,
        isSystem: true,
        sortOrder: (i + 1) * 10,
      })
      inserted++
    }
  }
  if (inserted > 0)
    console.log(`[attributes] seeded ${inserted} system attributes`)

  const linked = await seedEnrichmentLinks(objectIds)
  if (linked > 0)
    console.log(`[attributes] linked ${linked} system attributes to enrichment`)
}

/**
 * The default enrichment links (D76) for system attributes seeded before
 * they existed: insert-if-absent on `options.enrichmentKey`. An attribute
 * the owner unlinked holds `enrichmentKey: null` and is never re-linked.
 */
async function seedEnrichmentLinks(
  objectIds: ReadonlyMap<ObjectKind, string>,
): Promise<number> {
  let linked = 0
  for (const objectKind of OBJECT_KINDS) {
    const objectId = objectIds.get(objectKind)
    if (objectId === undefined) continue
    for (const def of SYSTEM_ATTRIBUTES[objectKind]) {
      const key = def.options?.enrichmentKey
      if (key == null) continue
      const rows = await db
        .update(attribute)
        .set({
          options: sql`${attribute.options} || jsonb_build_object('enrichmentKey', ${key}::text)`,
        })
        .where(
          and(
            eq(attribute.objectId, objectId),
            eq(attribute.slug, def.slug),
            eq(attribute.isSystem, true),
            sql`not (${attribute.options} ? 'enrichmentKey')`,
          ),
        )
        .returning({ id: attribute.id })
      linked += rows.length
    }
  }
  return linked
}
