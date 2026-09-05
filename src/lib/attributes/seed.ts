import { and, eq } from 'drizzle-orm'
import { db } from '#/db'
import { attribute, objectDef } from '#/db/schema'
import { CORE_OBJECTS, SYSTEM_ATTRIBUTES } from './registry'
import type { ObjectKind } from './registry'

/**
 * Idempotent system seed — runs on every boot (after migrations). Inserts
 * what's missing; never overwrites existing rows, because nouns and options
 * are user-editable content after first boot. New system objects/attributes
 * added in a release appear on upgrade without stomping user edits.
 */
export async function seedSystemAttributes() {
  const objectIds = new Map<ObjectKind, string>()
  let insertedObjects = 0
  for (const kind of Object.keys(CORE_OBJECTS) as Array<ObjectKind>) {
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
  for (const objectKind of Object.keys(
    SYSTEM_ATTRIBUTES,
  ) as Array<ObjectKind>) {
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
        isSystem: true,
        sortOrder: (i + 1) * 10,
      })
      inserted++
    }
  }
  if (inserted > 0)
    console.log(`[attributes] seeded ${inserted} system attributes`)
}
