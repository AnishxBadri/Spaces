import { Effect } from 'effect'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'

/**
 * The lowering half of `chunk.sensitive`: one `sensitivity.restamp` job per
 * entity, keyed by its id, sent after the commit that cleared a flag or
 * removed a filing. The job resolves live, so an entity still sensitive
 * through another input stays stamped.
 *
 * Never fails, like every enqueue: a failed send leaves the chunks stamped
 * `true`, the cautious direction. Answers how many were sent.
 * - Sends through `enqueue`, so a test that mocks the queue records it.
 */
export const enqueueRestampProgram = Effect.fn('enqueueRestampProgram')(
  function* (entityIds: ReadonlyArray<string>) {
    let sent = 0
    for (const entityId of entityIds) {
      const id = yield* Effect.promise(() =>
        enqueue(
          QUEUES.restampSensitivity,
          { entityId },
          { singletonKey: entityId },
        ),
      )
      if (id !== null) sent += 1
    }
    return sent
  },
)

/** `enqueueRestampProgram` for a caller that is not Effect. */
export async function enqueueRestamp(
  entityIds: ReadonlyArray<string>,
): Promise<number> {
  return Effect.runPromise(enqueueRestampProgram(entityIds))
}

/**
 * The lowering after the workspace default goes back to normal: one
 * `sensitivity.restamp` job over every entity still stamped, not one per
 * entity. Never fails; answers whether it was sent.
 */
export const enqueueRestampAllProgram = Effect.fn('enqueueRestampAllProgram')(
  function* () {
    const id = yield* Effect.promise(() =>
      enqueue(
        QUEUES.restampSensitivity,
        { all: true },
        { singletonKey: 'all' },
      ),
    )
    return id !== null
  },
)

/** `enqueueRestampAllProgram` for a caller that is not Effect. */
export async function enqueueRestampAll(): Promise<boolean> {
  return Effect.runPromise(enqueueRestampAllProgram())
}
