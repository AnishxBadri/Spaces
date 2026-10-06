import { Effect, Schema } from 'effect'
import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { chunk } from '@spaces/db/schema'
import { sensitivityFor } from './sensitivity-for'
import type { SQL } from 'drizzle-orm'
import type { Tx } from '../attributes/values'
import type {
  SensitivityEntityNotFound,
  SensitivityRead,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * The only module that writes `chunk.sensitive`, a derived cache of the
 * resolver so retrieval can filter in SQL before scoring. Two writers, one
 * per direction:
 *
 * - `stampSensitivity(entityId)` resolves the entity live (`sensitivityFor`)
 *   and writes the answer onto every chunk it owns. The embed job calls it
 *   for the chunks it has just written; the `sensitivity.restamp` job calls
 *   it after a flag is cleared or a filing removed.
 * - `raiseSensitivity(tx, scope)` is the set-based raise, run inside the
 *   transaction that flags a record or files one into a sensitive space.
 *
 * Raising is synchronous and lowering is a job: the cautious OR means a new
 * sensitive input can only raise, so the raise needs no resolver; a removed
 * one may leave another input still holding the entity sensitive, so the
 * lowering resolves live. `stampedSensitive` names the entities a lowering
 * must restamp.
 *
 * The routing boundary never reads this column — `complete()` and `embed()`
 * resolve live, because a stale cache where bytes leave the box is a leak.
 */

export class StampWriteFailed extends Schema.TaggedError<StampWriteFailed>()(
  'StampWriteFailed',
  { cause: Schema.Defect() },
) {}

export type StampOptions = {
  /** Committed in the same transaction as the stamp, before it. */
  within?: (tx: Tx) => Promise<void>
}

export type StampResult = SensitivityRead & {
  /** Rows whose flag this call changed. */
  stamped: number
}

export const stampSensitivity = Effect.fn('stampSensitivity')(function* (
  entityId: string,
  opts: StampOptions = {},
): Effect.fn.Return<
  StampResult,
  SensitivityReadFailed | SensitivityEntityNotFound | StampWriteFailed
> {
  const resolved = yield* sensitivityFor(entityId)
  const sensitive = resolved.sensitivity === 'sensitive'
  const stamped = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        if (opts.within) await opts.within(tx)
        const rows = await tx
          .update(chunk)
          .set({ sensitive })
          .where(
            and(eq(chunk.entityId, entityId), ne(chunk.sensitive, sensitive)),
          )
          .returning({ id: chunk.id })
        return rows.length
      }),
    catch: (cause) => new StampWriteFailed({ cause }),
  })
  return { ...resolved, stamped }
})

/** Which entities a change of one sensitivity input reaches. */
export type StampScope =
  /**
   * A record's own flag: the record, and — for a space — every entity filed
   * in it or a descendant space, and the descendant spaces themselves.
   */
  | { kind: 'flagged'; entityId: string }
  /** One entity filed into, or out of, one space. */
  | { kind: 'filed'; entityId: string; spaceId: string }

/** The entity ids a `flagged` scope reaches. */
const flaggedReach = (entityId: string): SQL => sql`(
  select ${entityId}::uuid
  union
  select es.entity_id
  from entity_space es
  join space s on s.entity_id = es.space_id
  join space root on root.entity_id = ${entityId}::uuid
  where root.path @> s.path
  union
  select s.entity_id
  from space s
  join space root on root.entity_id = ${entityId}::uuid
  where root.path @> s.path
)`

/** True when the scope's input is sensitive now, so the raise may stamp. */
const inputSensitive = (scope: StampScope): SQL =>
  scope.kind === 'flagged'
    ? sql`exists (
        select 1 from entity e
        where e.id = ${scope.entityId}::uuid and e.sensitive
      )`
    : sql`exists (
        select 1
        from space filed
        join space anc on anc.path @> filed.path
        join entity ae on ae.id = anc.entity_id
        where filed.entity_id = ${scope.spaceId}::uuid and ae.sensitive
      )`

const reach = (scope: StampScope): SQL =>
  scope.kind === 'flagged'
    ? sql`${chunk.entityId} in ${flaggedReach(scope.entityId)}`
    : sql`${chunk.entityId} = ${scope.entityId}::uuid`

/**
 * The set-based raise: every chunk in the scope goes `sensitive = true`, in
 * one statement, when the scope's input is sensitive — a record's own flag
 * for `flagged`, the space or one of its ancestors for `filed`. A no-op
 * otherwise, so a caller runs it after every flag-set and every filing.
 * Answers the rows it changed.
 */
export async function raiseSensitivity(
  tx: Tx,
  scope: StampScope,
): Promise<number> {
  const rows = await tx
    .update(chunk)
    .set({ sensitive: true })
    .where(and(eq(chunk.sensitive, false), reach(scope), inputSensitive(scope)))
    .returning({ id: chunk.id })
  return rows.length
}

/**
 * The entities in the scope that own a chunk stamped `sensitive = true` —
 * the ones a lowering must hand to the `sensitivity.restamp` job. An entity
 * with nothing stamped has nothing to lower.
 */
export async function stampedSensitive(
  reader: Tx | typeof db,
  scope: StampScope,
): Promise<Array<string>> {
  const rows = await reader
    .selectDistinct({ entityId: chunk.entityId })
    .from(chunk)
    .where(and(eq(chunk.sensitive, true), reach(scope)))
  return rows.map((r) => r.entityId)
}
