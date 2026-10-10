import { Effect, Schema } from 'effect'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { objectDef, view } from '@spaces/db/schema'
import { canRead } from '@spaces/core/read-policy'

/**
 * Cmd-K's Jump to reads every saved view the user may open, with the list it
 * opens on. (D70)
 * - Object surfaces only, on live objects; a view private to someone else
 *   is left out by `canRead`, as the sidebar's pins are.
 * - Outside `lib/server/` so a test can call it without a request.
 */

export type JumpView = {
  id: string
  name: string
  /** The list the view opens on: `/companies`, or `/o/<slug>` for a custom object. */
  path: string
  /** The object's plural, printed in the row's path lane. */
  objectPlural: string
}

export class JumpViewsReadFailed extends Schema.TaggedError<JumpViewsReadFailed>()(
  'JumpViewsReadFailed',
  { cause: Schema.Defect() },
) {}

export const jumpViewsProgram = Effect.fn('jumpViews')(function* (user: {
  id: string
}): Effect.fn.Return<Array<JumpView>, JumpViewsReadFailed> {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          id: view.id,
          name: view.name,
          visibility: view.visibility,
          createdBy: view.createdBy,
          slug: objectDef.slug,
          plural: objectDef.plural,
          isSystem: objectDef.isSystem,
        })
        .from(view)
        .innerJoin(objectDef, eq(objectDef.id, view.objectId))
        .where(and(eq(view.surface, 'object'), eq(objectDef.archived, false)))
        .orderBy(asc(objectDef.plural), asc(view.name)),
    catch: (cause) => new JumpViewsReadFailed({ cause }),
  })
  return rows
    .filter((r) =>
      canRead(user, { visibility: r.visibility, authorId: r.createdBy }),
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      path: r.isSystem ? `/${r.slug}` : `/o/${r.slug}`,
      objectPlural: r.plural,
    }))
})
