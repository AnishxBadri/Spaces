import { and, eq, isNull } from 'drizzle-orm'
import type { db } from '@spaces/db'
import { entity, entitySpace, space } from '@spaces/db/schema'
import type { tagSource } from '@spaces/db/schema'
import { raiseSensitivity } from '@spaces/core/writes/ai/stamp-sensitivity'
import { filed } from '@spaces/core/writes/events/dispatch'
import type { DomainEvent } from '@spaces/sdk'
import type { Tx } from '@spaces/core/writes/attributes/values'

/**
 * The one insert that tags a record into a space (SPA-103). Callers: the
 * `tagIntoSpace` server fn (a person picks the space, `source: 'manual'`),
 * the `space_tag` accept branch in `acceptProgram` (a person accepts the
 * classify lane's proposal, `source: 'ai'` with the model's confidence) and
 * its discovery-card accepts (`fileDiscovered`, D72). `created_by` is the person either way — a model never
 * tags anything; the accepter does.
 *
 * `(entity_id, space_id)` is the primary key, so a record already in the
 * space keeps the row it has — its source, confidence and author — and the
 * answer is `tagged: false`. A new tag hands back the `filed` event its
 * caller dispatches after the commit (D76). `tag.test.ts` greps that these two call sites reach
 * `entity_space` through here and nowhere else.
 *
 * A new tag raises the record's chunks to `sensitive` in the caller's
 * transaction when the space, or one of its ancestors, is sensitive.
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

/**
 * Whether the tag was new, and the `filed` it owes once the caller's
 * transaction commits (null for a kind no event names, or no new tag).
 */
export type SpaceTagged = {
  readonly tagged: boolean
  readonly emit: DomainEvent | null
}

export async function insertSpaceTag(
  tx: Tx,
  input: TagIntoSpaceInput,
): Promise<SpaceTagged> {
  const inserted = await tx
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
  if (inserted.length === 0) return { tagged: false, emit: null }
  await raiseSensitivity(tx, {
    kind: 'filed',
    entityId: input.entityId,
    spaceId: input.spaceId,
  })
  const kind = (
    await tx
      .select({ kind: entity.kind })
      .from(entity)
      .where(eq(entity.id, input.entityId))
  ).at(0)?.kind
  return {
    tagged: true,
    emit:
      kind === undefined ? null : filed(input.entityId, kind, input.spaceId),
  }
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
