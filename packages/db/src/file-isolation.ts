import { sql } from 'drizzle-orm'
import { db } from './index.ts'
import {
  attribute,
  duplicateCandidate,
  entity,
  objectDef,
  view,
} from './schema/index.ts'
import { user } from './schema/auth.ts'

/**
 * The two halves of the per-file isolation regression test (SPA-145) —
 * `file-isolation-a.test.ts` and `file-isolation-b.test.ts` — are identical
 * apart from their tag, so the body lives here once.
 *
 * Like `test-db.ts` this is harness, not product: nothing that ships imports
 * it.
 */

export type PublicSchemaCounts = {
  entities: number
  attributes: number
  views: number
  duplicateCandidates: number
  journal: number
}

/**
 * What the probe asserts about the database it was handed: the four tables a
 * probe writes are empty, and the drizzle journal is not. The journal is the
 * point of the last number — the truncate names tables in `public` only, and
 * `__drizzle_migrations` lives in the `drizzle` schema, so a truncate that
 * had grown teeth would show up here as a migration count of zero.
 */
export async function readPublicSchemaCounts(): Promise<PublicSchemaCounts> {
  const rows = await db.execute<{
    entities: number
    attributes: number
    views: number
    candidates: number
    journal: number
  }>(sql`
    select
      (select count(*)::int from entity) as entities,
      (select count(*)::int from attribute) as attributes,
      (select count(*)::int from view) as views,
      (select count(*)::int from duplicate_candidate) as candidates,
      (select count(*)::int from drizzle.__drizzle_migrations) as journal
  `)
  const row = rows.rows.at(0)
  if (!row) throw new Error('[file-isolation] the count query returned no row')
  return {
    entities: row.entities,
    attributes: row.attributes,
    views: row.views,
    duplicateCandidates: row.candidates,
    journal: row.journal,
  }
}

/**
 * One attribute, one view and one duplicate_candidate — the three rows
 * `cleanupTestEntities` could not reach, since none of them carries a name
 * for a regex to match. Left behind deliberately: the other half of the pair
 * is what proves they do not survive to the next file.
 */
export async function writeIsolationProbe(tag: string): Promise<void> {
  const [object] = await db
    .insert(objectDef)
    .values({
      slug: `probe_${tag}`,
      singular: `Probe ${tag}`,
      plural: `Probes ${tag}`,
    })
    .returning({ id: objectDef.id })

  const [author] = await db
    .insert(user)
    .values({
      id: `probe-${tag}`,
      name: `Probe ${tag}`,
      email: `probe-${tag}@spaces.test`,
    })
    .returning({ id: user.id })

  await db.insert(attribute).values({
    objectId: object.id,
    slug: `probe_${tag}`,
    name: `Probe ${tag}`,
    type: 'text',
  })

  await db.insert(view).values({
    objectId: object.id,
    name: `Probe ${tag}`,
    createdBy: author.id,
  })

  const pair = await db
    .insert(entity)
    .values([
      { kind: 'company', canonicalName: `ProbeCo A ${tag}`, source: 'manual' },
      { kind: 'company', canonicalName: `ProbeCo B ${tag}`, source: 'manual' },
    ])
    .returning({ id: entity.id })

  await db.insert(duplicateCandidate).values({
    entityA: pair[0].id,
    entityB: pair[1].id,
    score: 0.9,
    reason: { probe: tag },
  })
}
