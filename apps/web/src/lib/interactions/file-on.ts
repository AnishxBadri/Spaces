import { Effect, Schema } from 'effect'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, interaction, interactionEntity } from '@spaces/db/schema'
import { recomputeInteractionStats } from '@spaces/core/writes/interactions/stats'

/**
 * An interaction's edges to records, by hand: `File on a deal…` adds one and
 * `Unlink from <record>…` takes one away, from a thread's row `···`.
 * - One `interaction_entity` row each way, and the record's
 *   `interaction_stat` rebuilt in the same transaction.
 * - Nothing else moves: the interaction, its body and its other edges stay.
 */

export class InteractionEdgeNotFound extends Schema.TaggedError<InteractionEdgeNotFound>()(
  'InteractionEdgeNotFound',
  { what: Schema.Literals(['interaction', 'record']) },
) {}

export class InteractionEdgeFailed extends Schema.TaggedError<InteractionEdgeFailed>()(
  'InteractionEdgeFailed',
  { cause: Schema.Defect() },
) {}

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function interactionEdgeMessage(failure: unknown): string {
  if (failure instanceof InteractionEdgeNotFound)
    return failure.what === 'interaction'
      ? 'That interaction is no longer there'
      : 'That record is no longer there'
  return 'Could not change where it is filed'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InteractionEdgeFailed({ cause }),
  })

/** File an interaction on a live record; filing it twice is a no-op. */
export const fileInteractionOnEntityProgram = Effect.fn(
  'fileInteractionOnEntityProgram',
)(function* (
  interactionId: string,
  entityId: string,
): Effect.fn.Return<
  { filed: boolean },
  InteractionEdgeNotFound | InteractionEdgeFailed
> {
  const found = yield* query(() =>
    db
      .select({ id: interaction.id })
      .from(interaction)
      .where(eq(interaction.id, interactionId)),
  )
  if (found.length === 0)
    return yield* new InteractionEdgeNotFound({ what: 'interaction' })
  const live = yield* query(() =>
    db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.id, entityId), isNull(entity.mergedIntoId))),
  )
  if (live.length === 0)
    return yield* new InteractionEdgeNotFound({ what: 'record' })

  return yield* query(() =>
    db.transaction(async (tx) => {
      const added = await tx
        .insert(interactionEntity)
        .values({ interactionId, entityId })
        .onConflictDoNothing()
        .returning({ entityId: interactionEntity.entityId })
      if (added.length > 0) await recomputeInteractionStats(tx, [entityId])
      return { filed: added.length > 0 }
    }),
  )
})

/** Take an interaction off one record; its other edges stay. */
export const unlinkInteractionFromEntityProgram = Effect.fn(
  'unlinkInteractionFromEntityProgram',
)(function* (
  interactionId: string,
  entityId: string,
): Effect.fn.Return<{ unlinked: boolean }, InteractionEdgeFailed> {
  return yield* query(() =>
    db.transaction(async (tx) => {
      const removed = await tx
        .delete(interactionEntity)
        .where(
          and(
            eq(interactionEntity.interactionId, interactionId),
            eq(interactionEntity.entityId, entityId),
          ),
        )
        .returning({ entityId: interactionEntity.entityId })
      if (removed.length > 0) await recomputeInteractionStats(tx, [entityId])
      return { unlinked: removed.length > 0 }
    }),
  )
})
