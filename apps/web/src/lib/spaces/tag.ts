import { and, eq, isNull } from 'drizzle-orm'
import type { db } from '@spaces/db'
import { entity, entitySpace, space } from '@spaces/db/schema'
import type { tagSource } from '@spaces/db/schema'
import type { Tx } from '#/lib/attributes/values'

/**
 * The one insert that tags a record into a space (SPA-103). Two callers:
 * the `tagIntoSpace` server fn (a person picks the space, `source:
 * 'manual'`) and the `space_tag` accept branch in `lib/ai/propose.ts` (a
 * person accepts the classify lane's proposal, `source: 'ai'` with the
 * model's confidence). `created_by` is the person either way — a model never
 * tags anything; the accepter does.
 *
 * `(entity_id, space_id)` is the primary key, so a record already in the
 * space keeps the row it has — its source, confidence and author — and the
 * answer is `false`. `tag.test.ts` greps that these two call sites reach
 * `entity_space` through here and nowhere else.
 *
 * It lives outside `lib/server/` so the accept path, which runs without a
 * request, can call it, and nothing here reaches the client bundle
 * (CLAUDE.md, SPA-155).
 */

export type TagSource = (typeof tagSource.enumValues)[number]

export type TagIntoSpaceInput = {
  entityId: string
  spaceId: string
  source: TagSource
  /** The model's confidence for an AI tag; null for a person's. */
  confidence: number | null
  createdBy: string
}

export async function insertSpaceTag(
  writer: Tx | typeof db,
  input: TagIntoSpaceInput,
): Promise<boolean> {
  const inserted = await writer
    .insert(entitySpace)
    .values({
      entityId: input.entityId,
      spaceId: input.spaceId,
      source: input.source,
      confidence: input.confidence,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing()
    .returning({ entityId: entitySpace.entityId })
  return inserted.length > 0
}

/**
 * Whether `spaceId` is a live space — a row in `space` whose entity has not
 * been merged away. The accept branch asks before tagging, because a space
 * proposed last week may have been merged since.
 */
export async function isLiveSpace(
  reader: Tx | typeof db,
  spaceId: string,
): Promise<boolean> {
  const row = (
    await reader
      .select({ id: space.entityId })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(and(eq(space.entityId, spaceId), isNull(entity.mergedIntoId)))
  ).at(0)
  return row !== undefined
}
