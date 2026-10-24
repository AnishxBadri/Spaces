import { Effect, Schema } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entitySpace, space } from '@spaces/db/schema'
import type { DomainEvent } from '@spaces/sdk'
import { tagByHand, untagByHand } from './tag'

/**
 * Split by hand: Move here untags each chosen company from a space and tags
 * it into one of that space's subspaces. Filings never move on their own;
 * this is the explicit choice that moves them.
 * Outside the server-fn module so tests call the program directly.
 */

export class MoveHereFailed extends Schema.TaggedError<MoveHereFailed>()(
  'MoveHereFailed',
  { cause: Schema.Defect() },
) {}

/** A refusal the selection bar shows as it is. */
export class MoveHereRefused extends Schema.TaggedError<MoveHereRefused>()(
  'MoveHereRefused',
  { message: Schema.String },
) {}

export type MoveHereInput = {
  fromSpaceId: string
  toSpaceId: string
  entityIds: ReadonlyArray<string>
}

/** What the server fn owes after the commit: the events and the restamps. */
export type MovedHere = {
  moved: Array<string>
  emits: Array<DomainEvent>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MoveHereFailed({ cause }),
  })

const refuse = (message: string) => new MoveHereRefused({ message })

/**
 * Untag then tag, per company, in one transaction, through the hand writers.
 * - The target must be a direct subspace of the source.
 * - Only the source's own filings move; one filed through a subspace is
 *   already in a child, and the whole move refuses rather than half-run.
 */
export const moveHereProgram = Effect.fn('moveHereProgram')(function* (
  actorId: string,
  input: MoveHereInput,
): Effect.fn.Return<MovedHere, MoveHereRefused | MoveHereFailed> {
  const ids = [...new Set(input.entityIds)]
  if (ids.length === 0) return yield* refuse('Nothing is selected')
  const target = (yield* query(() =>
    db
      .select({ parentId: space.parentId })
      .from(space)
      .where(eq(space.entityId, input.toSpaceId)),
  )).at(0)
  if (target?.parentId !== input.fromSpaceId)
    return yield* refuse('Move here goes into a subspace of this space')
  const direct = yield* query(() =>
    db
      .select({ entityId: entitySpace.entityId })
      .from(entitySpace)
      .where(
        and(
          eq(entitySpace.spaceId, input.fromSpaceId),
          inArray(entitySpace.entityId, ids),
        ),
      ),
  )
  if (direct.length !== ids.length)
    return yield* refuse('Only companies filed here directly can move')
  const emits = yield* query(() =>
    db.transaction(async (tx) => {
      const owed: Array<DomainEvent> = []
      for (const entityId of ids) {
        await untagByHand(tx, {
          entityId,
          spaceId: input.fromSpaceId,
          actorId,
        })
        const { emit } = await tagByHand(tx, {
          entityId,
          spaceId: input.toSpaceId,
          actorId,
        })
        if (emit !== null) owed.push(emit)
      }
      return owed
    }),
  )
  return { moved: ids, emits }
})

/** The sentence a failed move shows. */
export function moveHereMessage(failure: unknown): string {
  return failure instanceof MoveHereRefused
    ? failure.message
    : 'Could not move the companies'
}
