import { and, eq } from 'drizzle-orm'
import { db } from '#/db'
import { attribute } from '#/db/schema'
import { SYSTEM_ATTRIBUTES } from './registry'
import type { ObjectKind } from './registry'

/**
 * Idempotent system-attribute seed — runs on every boot (after migrations).
 * Inserts what's missing; never overwrites existing rows, because options
 * are user-editable content after first boot. New system attributes added
 * in a release appear on upgrade without stomping user edits.
 */
export async function seedSystemAttributes() {
  let inserted = 0
  for (const objectKind of Object.keys(
    SYSTEM_ATTRIBUTES,
  ) as Array<ObjectKind>) {
    const defs = SYSTEM_ATTRIBUTES[objectKind]
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]
      const existing = await db
        .select({ id: attribute.id })
        .from(attribute)
        .where(
          and(
            eq(attribute.objectKind, objectKind),
            eq(attribute.slug, def.slug),
          ),
        )
        .limit(1)
      if (existing.length > 0) continue
      await db.insert(attribute).values({
        objectKind,
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
