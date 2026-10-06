import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'

/**
 * The lowering half of `chunk.sensitive`: one `sensitivity.restamp` job per
 * entity, keyed by its id, sent after the commit that cleared a flag or
 * removed a filing. The job resolves live, so an entity still sensitive
 * through another input stays stamped.
 *
 * Never throws, like every enqueue: a failed send leaves the chunks stamped
 * `true`, the cautious direction. Answers how many were sent.
 */
export async function enqueueRestamp(
  entityIds: ReadonlyArray<string>,
): Promise<number> {
  let sent = 0
  for (const entityId of entityIds) {
    const id = await enqueue(
      QUEUES.restampSensitivity,
      { entityId },
      { singletonKey: entityId },
    )
    if (id !== null) sent += 1
  }
  return sent
}
