import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
  sensitivityFor,
} from '@spaces/core/writes/ai/sensitivity-for'
import {
  raiseSensitivity,
  stampedSensitive,
} from '@spaces/core/writes/ai/stamp-sensitivity'
import type { SensitivityRead } from '@spaces/core/writes/ai/sensitivity-for'
import type { StampScope } from '@spaces/core/writes/ai/stamp-sensitivity'
import { enqueueRestamp } from './enqueue-restamp'

export { SensitivityEntityNotFound, SensitivityReadFailed, sensitivityFor }
export type { SensitivityRead }

/**
 * Write a record's own flag — the one write `entity.sensitive` has. Any
 * member may flag a record.
 *
 * - Inheritance never writes an `entity` row: a company filed under a
 *   sensitive space keeps `sensitive = false` and resolves sensitive at read.
 * - The chunk cache follows in both directions. Setting the flag raises the
 *   record's chunks — and, for a space, every entity filed beneath it — in
 *   the same transaction; clearing it enqueues `sensitivity.restamp` for
 *   each entity in that reach still stamped sensitive, after the commit.
 * - An egress flag, never access control — `canRead` stays the only thing
 *   that hides a row from a user.
 */
export const setEntitySensitiveProgram = Effect.fn('setEntitySensitive')(
  function* (
    entityId: string,
    sensitive: boolean,
  ): Effect.fn.Return<
    SensitivityRead,
    SensitivityReadFailed | SensitivityEntityNotFound
  > {
    const scope: StampScope = { kind: 'flagged', entityId }
    const lowered = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const updated = await tx
            .update(entity)
            .set({ sensitive })
            .where(eq(entity.id, entityId))
            .returning({ id: entity.id })
          if (updated.length === 0) return null
          if (sensitive) {
            await raiseSensitivity(tx, scope)
            return []
          }
          return stampedSensitive(tx, scope)
        }),
      catch: (cause) => new SensitivityReadFailed({ cause }),
    })
    if (lowered === null)
      return yield* new SensitivityEntityNotFound({ entityId })
    if (lowered.length > 0) yield* Effect.promise(() => enqueueRestamp(lowered))
    return yield* sensitivityFor(entityId)
  },
)
