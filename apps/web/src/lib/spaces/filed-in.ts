import { asc, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, space } from '@spaces/db/schema'
import { liveSpaceSql } from './live'

/**
 * The spaces a record is filed in, for its details column. Filings outlive
 * an archive: an archived space stays in the list with `archived` set, and
 * the rail dims it and offers no action.
 */
export function recordSpaces(entityId: string) {
  return db
    .select({
      id: space.entityId,
      name: entity.canonicalName,
      source: entitySpace.source,
      archived: sql<boolean>`not ${liveSpaceSql}`,
    })
    .from(entitySpace)
    .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
    .innerJoin(entity, eq(entity.id, space.entityId))
    .where(eq(entitySpace.entityId, entityId))
    .orderBy(asc(entity.canonicalName))
}
