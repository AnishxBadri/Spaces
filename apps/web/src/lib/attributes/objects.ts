import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { objectDef } from '@spaces/db/schema'
import { CORE_OBJECTS } from '@spaces/core/attributes/registry'
import type { ObjectKind } from '@spaces/core/attributes/registry'

/**
 * Kind → object-row resolution for the core objects (Effect-first per the
 * backend-paradigm ratchet). System object ids are stable after seed, so
 * they're cached for the process lifetime; custom objects are addressed by
 * object_id directly and never pass through here.
 */

export class SystemObjectNotSeeded extends Schema.TaggedError<SystemObjectNotSeeded>()(
  'SystemObjectNotSeeded',
  { kind: Schema.String },
) {}

export class ObjectQueryFailed extends Schema.TaggedError<ObjectQueryFailed>()(
  'ObjectQueryFailed',
  { cause: Schema.Defect() },
) {}

const idByKind = new Map<ObjectKind, string>()

export const objectIdForKind = Effect.fn('objectIdForKind')(function* (
  kind: ObjectKind,
): Effect.fn.Return<string, SystemObjectNotSeeded | ObjectQueryFailed> {
  const cached = idByKind.get(kind)
  if (cached) return cached
  const row = yield* Effect.tryPromise({
    try: async () =>
      (
        await db
          .select({ id: objectDef.id })
          .from(objectDef)
          .where(eq(objectDef.slug, CORE_OBJECTS[kind].slug))
      ).at(0),
    catch: (cause) => new ObjectQueryFailed({ cause }),
  })
  if (!row) return yield* new SystemObjectNotSeeded({ kind })
  idByKind.set(kind, row.id)
  return row.id
})

/**
 * Promise seam for call sites the ratchet hasn't converted yet
 * (`setValues`, seed, creation server-fns). New Effect code composes
 * `objectIdForKind` directly instead.
 */
export const objectIdForKindAsync = (kind: ObjectKind): Promise<string> =>
  Effect.runPromise(objectIdForKind(kind))
