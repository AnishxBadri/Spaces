import { Effect } from 'effect'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, space } from '@spaces/db/schema'
import type { tagSource } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import {
  raiseSensitivity,
  stampedSensitive,
} from '@spaces/core/writes/ai/stamp-sensitivity'
import { filed } from '@spaces/core/writes/events/dispatch'
import type { DomainEvent } from '@spaces/sdk'
import type { Tx } from '@spaces/core/writes/attributes/values'
import { spacesQuery } from './query'

/**
 * The one insert that tags a record into a space. Callers: `tagByHand`
 * (`source: 'manual'`), the `space_tag` accept branch in `acceptProgram`
 * (`source: 'ai'` with the model's confidence) and the discovery-card
 * accepts (`fileDiscovered`).
 * - `created_by` is always the person: a model never tags; the accepter does.
 * - A record already in the space keeps its row (`(entity_id, space_id)` is
 *   the primary key) and the answer is `tagged: false`.
 * - A new tag hands back the `filed` event its caller dispatches after the
 *   commit, and raises the record's chunks to `sensitive` in the caller's
 *   transaction when the space or an ancestor is sensitive.
 * - Tests grep that tagging reaches `entity_space` through here only.
 * - Outside the server-fn module so the accept path can call it without a
 *   request, and nothing here reaches the client bundle.
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

export const insertSpaceTagProgram = Effect.fn('insertSpaceTagProgram')(
  function* (tx: Tx, input: TagIntoSpaceInput) {
    const inserted = yield* spacesQuery(() =>
      tx
        .insert(entitySpace)
        .values({
          entityId: input.entityId,
          spaceId: input.spaceId,
          source: input.source,
          confidence: input.confidence,
          createdBy: input.createdBy,
        })
        .onConflictDoNothing()
        .returning({ entityId: entitySpace.entityId }),
    )
    const none: SpaceTagged = { tagged: false, emit: null }
    if (inserted.length === 0) return none
    yield* Effect.promise(() =>
      raiseSensitivity(tx, {
        kind: 'filed',
        entityId: input.entityId,
        spaceId: input.spaceId,
      }),
    )
    const kind = (yield* spacesQuery(() =>
      tx
        .select({ kind: entity.kind })
        .from(entity)
        .where(eq(entity.id, input.entityId)),
    )).at(0)?.kind
    const tagged: SpaceTagged = {
      tagged: true,
      emit:
        kind === undefined ? null : filed(input.entityId, kind, input.spaceId),
    }
    return tagged
  },
)

/** `insertSpaceTagProgram` for a caller that is not Effect. */
export async function insertSpaceTag(
  tx: Tx,
  input: TagIntoSpaceInput,
): Promise<SpaceTagged> {
  return Effect.runPromise(insertSpaceTagProgram(tx, input))
}

/**
 * Whether `spaceId` is a live space — a row in `space` whose entity has not
 * been merged away. The accept branch asks before tagging, because a
 * proposed space may have been merged since.
 */
export const isLiveSpaceProgram = Effect.fn('isLiveSpaceProgram')(function* (
  reader: Tx | typeof db,
  spaceId: string,
) {
  const row = (yield* spacesQuery(() =>
    reader
      .select({ id: space.entityId })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(and(eq(space.entityId, spaceId), isNull(entity.mergedIntoId))),
  )).at(0)
  return row !== undefined
})

/** `isLiveSpaceProgram` for a caller that is not Effect. */
export async function isLiveSpace(
  reader: Tx | typeof db,
  spaceId: string,
): Promise<boolean> {
  return Effect.runPromise(isLiveSpaceProgram(reader, spaceId))
}

/** A filing a person changes by hand: who, which record, which space. */
export type HandFiling = {
  entityId: string
  spaceId: string
  actorId: string
}

/**
 * A person tags a record into a space: the filing through `insertSpaceTag`
 * and its `space.tagged` history line, in the caller's transaction. The
 * `filed` event it hands back is dispatched after the commit.
 */
export async function tagByHand(tx: Tx, f: HandFiling): Promise<SpaceTagged> {
  const tagged = await insertSpaceTag(tx, {
    entityId: f.entityId,
    spaceId: f.spaceId,
    source: 'manual',
    confidence: null,
    createdBy: f.actorId,
  })
  await tx.insert(activity).values({
    actorId: f.actorId,
    verb: 'space.tagged',
    subjectEntityId: f.entityId,
    objectEntityId: f.spaceId,
  })
  return tagged
}

/**
 * A person untags a record from a space: the filing goes and a
 * `space.untagged` history line says so, in the caller's transaction.
 * - The caller runs `restampUntagged` after the commit.
 */
export const untagByHandProgram = Effect.fn('untagByHandProgram')(function* (
  tx: Tx,
  f: HandFiling,
) {
  yield* spacesQuery(() =>
    tx
      .delete(entitySpace)
      .where(
        and(
          eq(entitySpace.entityId, f.entityId),
          eq(entitySpace.spaceId, f.spaceId),
        ),
      ),
  )
  yield* spacesQuery(() =>
    tx.insert(activity).values({
      actorId: f.actorId,
      verb: 'space.untagged',
      subjectEntityId: f.entityId,
      objectEntityId: f.spaceId,
    }),
  )
})

/** `untagByHandProgram` for a caller that is not Effect. */
export async function untagByHand(tx: Tx, f: HandFiling): Promise<void> {
  return Effect.runPromise(untagByHandProgram(tx, f))
}

/**
 * The lowering half of an untag, after the commit and never inside it:
 * another space may still hold the record sensitive, so it is a job.
 */
export const restampUntaggedProgram = Effect.fn('restampUntaggedProgram')(
  function* (entityId: string, spaceId: string) {
    const ids = yield* Effect.promise(() =>
      stampedSensitive(db, { kind: 'filed', entityId, spaceId }),
    )
    const { enqueueRestamp } = yield* Effect.promise(
      () => import('../ai/enqueue-restamp'),
    )
    // Never fails, like every enqueue.
    yield* Effect.promise(() => enqueueRestamp(ids))
  },
)

/** `restampUntaggedProgram` for a caller that is not Effect. */
export async function restampUntagged(
  entityId: string,
  spaceId: string,
): Promise<void> {
  return Effect.runPromise(restampUntaggedProgram(entityId, spaceId))
}
