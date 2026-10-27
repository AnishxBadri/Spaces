import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import type { DomainEvent } from '@spaces/sdk'
import { isLiveSpace, tagByHand } from './tag'

/**
 * Add to space from a list's selection: every chosen record tagged into one
 * space by hand, in one transaction.
 * - A record already in the space keeps its row and is not in `tagged`, so
 *   an Undo that untags `tagged` restores exactly what was there before.
 * - Outside the server-fn module so tests call the program directly.
 */

export class TagManyFailed extends Schema.TaggedError<TagManyFailed>()(
  'TagManyFailed',
  { cause: Schema.Defect() },
) {}

/** A refusal the window shows as it is. */
export class TagManyRefused extends Schema.TaggedError<TagManyRefused>()(
  'TagManyRefused',
  { message: Schema.String },
) {}

export type TagManyInput = {
  spaceId: string
  entityIds: ReadonlyArray<string>
}

/** The records this call tagged, and the events owed after the commit. */
export type TaggedMany = {
  tagged: Array<string>
  emits: Array<DomainEvent>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TagManyFailed({ cause }),
  })

export const tagManyProgram = Effect.fn('tagManyProgram')(function* (
  actorId: string,
  input: TagManyInput,
): Effect.fn.Return<TaggedMany, TagManyRefused | TagManyFailed> {
  const ids = [...new Set(input.entityIds)]
  if (ids.length === 0)
    return yield* new TagManyRefused({ message: 'Nothing is selected' })
  if (!(yield* query(() => isLiveSpace(db, input.spaceId))))
    return yield* new TagManyRefused({ message: 'That space is gone' })
  return yield* query(() =>
    db.transaction(async (tx) => {
      const out: TaggedMany = { tagged: [], emits: [] }
      for (const entityId of ids) {
        const { tagged, emit } = await tagByHand(tx, {
          entityId,
          spaceId: input.spaceId,
          actorId,
        })
        if (tagged) out.tagged.push(entityId)
        if (emit !== null) out.emits.push(emit)
      }
      return out
    }),
  )
})

/** The sentence a failed Add to space shows. */
export function tagManyMessage(failure: unknown): string {
  return failure instanceof TagManyRefused
    ? failure.message
    : 'Could not add to the space'
}
