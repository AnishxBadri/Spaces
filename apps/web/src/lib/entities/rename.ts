import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { recordNameAlias } from './resolve'

/**
 * Renaming a record, for every object-model kind `updateRecord` serves
 * (SPA-63). Before this, the rename set `entity.canonical_name` and kept
 * nothing: the old name fell out of Cmd-K the moment it was replaced, which
 * is the common drift case now that customs rename freely.
 *
 * So a rename is four writes, not one — the name, the activity row, and
 * *both* names through the insert-if-absent check `resolveEntity` already
 * uses: the one being left behind, then the one being taken. Recording the
 * old name is what makes the title true on its own — a custom record is
 * born with no alias at all (`createRecordProgram`: "no aliases, no dedupe
 * sweep"), so without it the birth name would be lost on the first rename
 * rather than the second. Recording the new one is what makes the *next*
 * rename cheap and what puts the current name in `entity_alias`, which is
 * why the dedupe card had to stop comparing in the wrong normal form.
 *
 * Both are no-ops when the normalized name is already held, so a core kind
 * — born through `resolveEntity`, which already wrote its name alias —
 * gains exactly one row per rename, not two.
 *
 * Names are history: an earlier alias is never replaced or deleted.
 * `searchEntities` matches `entity_alias` name rows already, so the record
 * stays findable by what it used to be called without any sweep running.
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
): Effect.fn.Return<{ ok: true }, RenameQueryFailed> {
  // Read the outgoing name before the update overwrites it.
  const before = yield* query(() =>
    db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, input.id))
      .then((rows) => rows.at(0)),
  )
  yield* query(() =>
    db
      .update(entity)
      .set({ canonicalName: input.name })
      .where(eq(entity.id, input.id)),
  )
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

  // No fuzzy sweep here, deliberately. The spec names two sweep lanes and
  // only two: at create (`resolveEntity`, on a freshly born entity) and the
  // nightly job (objects-4, over everything). A rename is neither, and a
  // third lane firing per rename would re-suggest the same pairs with no
  // new entity to justify them — drift is the nightly job's lane.

  return { ok: true }
})
