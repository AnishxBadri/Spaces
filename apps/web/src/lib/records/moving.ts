import { Effect, Schema } from 'effect'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { activity, entity, entitySpace, signal } from '@spaces/db/schema'
import { jsonRecord, jsonString } from '@spaces/core/json'

/** Today's What's moving: recent signals on the reader's companies. */

export class MovingFailed extends Schema.TaggedError<MovingFailed>()(
  'MovingFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MovingFailed({ cause }),
  })

/** A dated event on one of the user's companies. */
export type MovingSignal = {
  id: string
  companyId: string
  companyName: string
  /** The signal's own kind (`funding`, `web`, …), when it said. */
  kind: string | null
  title: string | null
  url: string | null
  /** The plugin id that emitted it. */
  source: string
  observedAt: string
}

/** What's moving looks back this far. */
export const MOVING_DAYS = 7
const MOVING_MAX = 12

/**
 * Signals from the last `MOVING_DAYS` on companies the user touched —
 * created, logged an interaction on, or filed — newest first.
 */
export const movingProgram = Effect.fn('movingProgram')(function* (
  userId: string,
  now: Date,
): Effect.fn.Return<MovingSignal[], MovingFailed> {
  const since = new Date(now.getTime() - MOVING_DAYS * 86_400_000)
  const touched = sql`(
    ${entity.createdBy} = ${userId}
    or exists (
      select 1 from ${entitySpace}
      where ${entitySpace.entityId} = ${entity.id}
        and ${entitySpace.createdBy} = ${userId}
    )
    or exists (
      select 1 from ${activity}
      where ${activity.subjectEntityId} = ${entity.id}
        and ${activity.actorId} = ${userId}
        and ${activity.verb} like 'interaction.%'
    )
  )`
  const rows = yield* query(() =>
    db
      .select({
        id: signal.id,
        companyId: entity.id,
        companyName: entity.canonicalName,
        source: signal.source,
        payload: signal.payload,
        observedAt: signal.observedAt,
      })
      .from(signal)
      .innerJoin(entity, eq(entity.id, signal.entityId))
      .where(
        and(
          eq(entity.kind, 'company'),
          isNull(entity.mergedIntoId),
          gte(signal.observedAt, since),
          touched,
        ),
      )
      .orderBy(desc(signal.observedAt), desc(signal.id))
      .limit(MOVING_MAX),
  )
  return rows.map((r) => {
    const p = jsonRecord(r.payload)
    return {
      id: r.id,
      companyId: r.companyId,
      companyName: r.companyName,
      kind: jsonString(p.kind),
      title: jsonString(p.title),
      url: jsonString(p.url),
      source: r.source,
      observedAt: r.observedAt.toISOString(),
    }
  })
})
