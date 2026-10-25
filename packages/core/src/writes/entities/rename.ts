import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { recordNameAlias } from './resolve'
import { setValuesEffect } from '../attributes/values'
import type { AttributeValidationError } from '../attributes/values'

/**
 * Renaming a record, for every object-model kind `updateRecord` serves. Four
 * writes: the name, the activity row, and both names through the
 * insert-if-absent alias check — the old one first, then the new.
 * - Names are history: an earlier alias is never replaced or deleted, so
 *   `searchEntities` still finds the record by what it used to be called.
 * - Both are no-ops when the normalized name is already held, so a rename
 *   gains at most one row.
 * - A person's name is the join of `first_name` and `last_name`, so a
 *   person's rename goes through `setValues`, which splits it.
 */

export class RenameQueryFailed extends Schema.TaggedError<RenameQueryFailed>()(
  'RenameQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RenameQueryFailed({ cause }),
  })

export type RenameRecordInput = {
  id: string
  /** already trimmed and length-checked by the server fn's validator */
  name: string
}

export const renameRecordProgram = Effect.fn('renameRecordProgram')(function* (
  actorId: string,
  input: RenameRecordInput,
): Effect.fn.Return<
  { ok: true },
  RenameQueryFailed | AttributeValidationError
> {
  // Read the outgoing name before the update overwrites it.
  const before = yield* query(() =>
    db
      .select({ name: entity.canonicalName, kind: entity.kind })
      .from(entity)
      .where(eq(entity.id, input.id))
      .then((rows) => rows.at(0)),
  )
  if (before?.kind === 'person') {
    yield* setValuesEffect({
      entityId: input.id,
      patch: {},
      actor: { type: 'user', id: actorId },
      name: input.name,
    }).pipe(
      Effect.catchTags({
        EntityNotFound: (cause) =>
          Effect.fail(new RenameQueryFailed({ cause })),
        ValuesWriteFailed: (cause) =>
          Effect.fail(new RenameQueryFailed({ cause })),
        PairedAttributeLocked: (cause) =>
          Effect.fail(new RenameQueryFailed({ cause })),
      }),
    )
  } else {
    yield* query(() =>
      db
        .update(entity)
        .set({ canonicalName: input.name })
        .where(eq(entity.id, input.id)),
    )
  }
  yield* query(() =>
    db.insert(activity).values({
      actorId,
      verb: 'renamed',
      subjectEntityId: input.id,
    }),
  )
  // Old name first, then new. Both `manual` with the acting user, exactly
  // as the at-create alias is stamped — a rename is not a new provenance
  // class.
  if (before) {
    yield* query(() =>
      recordNameAlias(input.id, before.name, { class: 'manual' }),
    )
  }
  yield* query(() => recordNameAlias(input.id, input.name, { class: 'manual' }))

  // No fuzzy sweep here, deliberately: the lanes are at create and the
  // nightly job. A sweep per rename would re-suggest the same pairs with no
  // new entity to justify them — drift is the nightly job's lane.

  return { ok: true }
})
