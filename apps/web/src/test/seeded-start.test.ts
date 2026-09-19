import { describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, objectDef, space } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import {
  CORE_OBJECTS,
  OBJECT_KINDS,
  SYSTEM_ATTRIBUTES,
} from '@spaces/core/attributes/registry'
import { FIXTURE_ACTOR } from '../../vitest.seed'

/**
 * What every file in this suite may assume about the database it was handed
 * (SPA-145): the seed, and nothing else.
 *
 * `vitest.setup.ts` truncates `public` and reseeds before each file, so this
 * is not a test of one file's luck — it is the invariant the other
 * twenty-three rely on when they do `select id from user limit 1` or ask for
 * `objectIdForKindAsync('company')`. The cross-file half of the regression
 * (rows written in one file are gone in the next) is
 * `packages/db/src/file-isolation-{a,b}.test.ts`, where a single worker makes
 * "the next file" deterministic; here the four workers have four databases.
 *
 * The probe rows written at the end are left behind on purpose: nothing
 * deletes them, so a second run of the suite that found them still there
 * would fail on the assertions above.
 */
describe('a file starts against the seed and nothing else', () => {
  it('has the core objects, the system attributes, the taxonomy and the actor', async () => {
    const objects = await db.select({ slug: objectDef.slug }).from(objectDef)
    expect(objects.map((o) => o.slug).sort()).toEqual(
      OBJECT_KINDS.map((kind) => CORE_OBJECTS[kind].slug).sort(),
    )

    const systemAttributes = OBJECT_KINDS.flatMap(
      (kind) => SYSTEM_ATTRIBUTES[kind],
    )
    const attributes = await db
      .select({ slug: attribute.slug, isSystem: attribute.isSystem })
      .from(attribute)
    expect(attributes).toHaveLength(systemAttributes.length)
    expect(attributes.every((a) => a.isSystem)).toBe(true)

    const spaces = await db.select({ path: space.path }).from(space)
    expect(spaces.map((s) => s.path).sort()).toEqual([
      'aerospace',
      'aerospace.in_space_manufacturing',
      'data_centers',
      'data_centers.cooling',
      'fintech',
    ])

    const actor = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, FIXTURE_ACTOR.id))
    expect(actor.at(0)?.email).toBe(FIXTURE_ACTOR.email)
  })

  it('carries nothing a previous file wrote', async () => {
    const leftovers = await db.execute<{
      views: number
      candidates: number
      events: number
      records: number
    }>(sql`
      select
        (select count(*)::int from view) as views,
        (select count(*)::int from duplicate_candidate) as candidates,
        (select count(*)::int from attribute_event) as events,
        (select count(*)::int from entity where kind <> 'space') as records
    `)
    expect(leftovers.rows.at(0)).toEqual({
      views: 0,
      candidates: 0,
      events: 0,
      records: 0,
    })

    // Deliberately uncleaned — see the file comment.
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: 'SeedProbe', source: 'manual' })
  })
})
