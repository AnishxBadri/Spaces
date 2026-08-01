import { inArray, or, sql } from 'drizzle-orm'

/**
 * Integration tests run against the dev database (no separate test db yet).
 * Every test entity name embeds a hex tag; this deletes everything a suite
 * created so reruns don't pollute the dev UI. Call from afterAll.
 */
export async function cleanupTestEntities(patterns: Array<string>) {
  const { db } = await import('#/db')
  const schema = await import('#/db/schema')

  const rows = await db
    .select({ id: schema.entity.id })
    .from(schema.entity)
    .where(
      or(...patterns.map((p) => sql`${schema.entity.canonicalName} ~ ${p}`)),
    )
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return

  const { entity, entityAlias, duplicateCandidate, mergeEvent, link } = schema
  const { entitySpace, company, person, space, note, attributeEvent } = schema
  const { activity } = await import('#/db/schema/activity')

  await db.delete(attributeEvent).where(inArray(attributeEvent.entityId, ids))

  await db
    .delete(mergeEvent)
    .where(
      or(inArray(mergeEvent.winnerId, ids), inArray(mergeEvent.loserId, ids)),
    )
  await db
    .delete(duplicateCandidate)
    .where(
      or(
        inArray(duplicateCandidate.entityA, ids),
        inArray(duplicateCandidate.entityB, ids),
      ),
    )
  await db.delete(entityAlias).where(inArray(entityAlias.entityId, ids))
  await db
    .delete(link)
    .where(or(inArray(link.fromEntityId, ids), inArray(link.toEntityId, ids)))
  await db
    .delete(entitySpace)
    .where(
      or(inArray(entitySpace.entityId, ids), inArray(entitySpace.spaceId, ids)),
    )
  await db
    .delete(activity)
    .where(
      or(
        inArray(activity.subjectEntityId, ids),
        inArray(activity.objectEntityId, ids),
      ),
    )
  await db.delete(company).where(inArray(company.entityId, ids))
  await db.delete(person).where(inArray(person.entityId, ids))
  await db.delete(space).where(inArray(space.entityId, ids))
  await db.delete(note).where(inArray(note.entityId, ids))
  await db
    .update(entity)
    .set({ mergedIntoId: null })
    .where(inArray(entity.mergedIntoId, ids))
  await db.delete(entity).where(inArray(entity.id, ids))
}
