import { Effect, Schema } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { objectDef, view } from '@spaces/db/schema'
import { canRead } from '@spaces/core/read-policy'

/**
 * The sidebar's read of pinned views: of the ids a browser has pinned, the
 * ones this user may still open, with the object each lists under.
 *
 * - A deleted view, a view private to someone else, a document-surface view
 *   and a view on an archived object are left out; the sidebar drops the
 *   pins it asked about and did not get back.
 * - Outside `lib/server/` so a test can call it without a request.
 */

export type PinnedView = {
  id: string
  name: string
  /** The object row's slug — `companies`, or a custom object's. */
  objectSlug: string
  visibility: 'shared' | 'private'
}

export class PinnedViewsReadFailed extends Schema.TaggedError<PinnedViewsReadFailed>()(
  'PinnedViewsReadFailed',
  { cause: Schema.Defect() },
) {}

export const pinnedViewsProgram = Effect.fn('pinnedViews')(function* (
  user: { id: string },
  ids: ReadonlyArray<string>,
): Effect.fn.Return<Array<PinnedView>, PinnedViewsReadFailed> {
  if (ids.length === 0) return []
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          id: view.id,
          name: view.name,
          visibility: view.visibility,
          createdBy: view.createdBy,
          objectSlug: objectDef.slug,
        })
        .from(view)
        .innerJoin(objectDef, eq(objectDef.id, view.objectId))
        .where(
          and(
            inArray(view.id, [...ids]),
            eq(view.surface, 'object'),
            eq(objectDef.archived, false),
          ),
        ),
    catch: (cause) => new PinnedViewsReadFailed({ cause }),
  })
  return rows
    .filter((r) =>
      canRead(user, { visibility: r.visibility, authorId: r.createdBy }),
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      objectSlug: r.objectSlug,
      visibility: r.visibility,
    }))
})
