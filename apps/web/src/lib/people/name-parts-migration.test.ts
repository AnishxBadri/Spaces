import { readFileSync } from 'node:fs'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { MIGRATIONS_FOLDER } from '@spaces/db/migrate'
import { attribute, entity, objectDef } from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema/entities'
import { splitName } from '@spaces/core/attributes/person-name'

/**
 * The data migration that split every person's name into `first_name` and
 * `last_name` and made phone a multi-valued E.164 list (D67). The test
 * database is already past it, so pre-migration rows are inserted raw and
 * its statements run again over them.
 */

const MIGRATION = path.join(MIGRATIONS_FOLDER, '0076_person_name_parts.sql')

async function runMigration() {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const statement of statements) await db.execute(sql.raw(statement))
}

/** A person as it stood before the migration: no parts, phone a string. */
async function legacyPerson(name: string, values: EntityValues = {}) {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'person', canonicalName: name, values })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('insert returned no row')
  return row.id
}

async function valuesOf(id: string) {
  return (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)?.values
}

describe('migration 0076: name parts and a multi phone', () => {
  it('splits every name on its last space, as splitName does', async () => {
    const names = [
      'Dana Moreau-Iyer',
      '  Jean  Claude Van Damme ',
      'Prince',
      'ana@submer.com',
    ]
    const ids = await Promise.all(names.map((n) => legacyPerson(n)))
    const held = await legacyPerson('Kept Whole', { first_name: 'Kept' })
    await runMigration()
    for (const [i, id] of ids.entries()) {
      const parts = splitName(names[i])
      const values = await valuesOf(id)
      expect(values?.first_name).toBe(parts.first)
      if (parts.last === null) expect(values).not.toHaveProperty('last_name')
      else expect(values?.last_name).toBe(parts.last)
    }
    // A person already holding a part is left alone.
    expect(await valuesOf(held)).toEqual({ first_name: 'Kept' })
  })

  it('makes the people phone multi and each phone a list of one', async () => {
    const people = (
      await db
        .select({ id: objectDef.id })
        .from(objectDef)
        .where(eq(objectDef.slug, 'people'))
    ).at(0)
    if (!people) throw new Error('no people object')
    const phone = and(
      eq(attribute.objectId, people.id),
      eq(attribute.slug, 'phone'),
    )
    // As an install seeded before the migration holds it.
    await db
      .update(attribute)
      .set({ options: sql`${attribute.options} - 'multi'` })
      .where(phone)
    const e164 = await legacyPerson('Aditi R', { phone: '+91 98450 11223' })
    const local = await legacyPerson('Suresh P', { phone: '(415) 555-0134' })
    await runMigration()

    const options = (
      await db
        .select({ options: attribute.options })
        .from(attribute)
        .where(phone)
    ).at(0)?.options
    expect(options?.multi).toBe(true)
    expect((await valuesOf(e164))?.phone).toEqual(['+919845011223'])
    expect((await valuesOf(local))?.phone).toEqual(['(415) 555-0134'])
  })
})
