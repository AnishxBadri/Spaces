import { Effect, Schema } from 'effect'
import { and, asc, eq, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { view } from '@spaces/db/schema'
import type { Condition, ViewExtra, ViewSort } from '@spaces/core/views/filter'
import type { ViewColumns, ViewSurface } from '@spaces/db/schema/views'
import type { ViewTarget } from './target'

export type { ViewSort, ViewSurface, ViewTarget }

/**
 * Views, the write side (Effect-first). Anyone may create a view, private
 * or shared; only its author or an admin may change or delete it. A view is
 * addressed by its `ViewTarget` — the surface, plus the object row when the
 * surface is `object` (D2, 2026-09-23). An object view references the object
 * row, never an entity, so the merge executor stays out of it.
 */

export class ViewNotFound extends Schema.TaggedError<ViewNotFound>()(
  'ViewNotFound',
  { id: Schema.String, message: Schema.String },
) {}

export class ViewForbidden extends Schema.TaggedError<ViewForbidden>()(
  'ViewForbidden',
  { message: Schema.String },
) {}

export class ViewQueryFailed extends Schema.TaggedError<ViewQueryFailed>()(
  'ViewQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ViewQueryFailed({ cause }),
  })

export type ViewRow = {
  id: string
  surface: ViewSurface
  objectId: string | null
  name: string
  filter: Array<Condition>
  sort: ViewSort
  columns: ViewColumns
  extra: ViewExtra
  visibility: 'shared' | 'private'
  createdBy: string
  updatedAt: string
}

const toRow = (r: typeof view.$inferSelect): ViewRow => ({
  id: r.id,
  surface: r.surface,
  objectId: r.objectId,
  name: r.name,
  filter: r.filter,
  sort: r.sort,
  columns: r.columns,
  extra: r.extra,
  visibility: r.visibility,
  createdBy: r.createdBy,
  updatedAt: r.updatedAt.toISOString(),
})

/** The where-clause half of a target: the surface, and the object when it has one. */
const onTarget = (target: ViewTarget) =>
  target.surface === 'object'
    ? and(eq(view.surface, 'object'), eq(view.objectId, target.objectId))
    : eq(view.surface, target.surface)

/** Shared views plus the caller's private ones, name order. */
export const listViewsProgram = Effect.fn('listViewsProgram')(function* (
  target: ViewTarget,
  userId: string,
): Effect.fn.Return<Array<ViewRow>, ViewQueryFailed> {
  const rows = yield* query(() =>
    db
      .select()
      .from(view)
      .where(
        and(
          onTarget(target),
          or(eq(view.visibility, 'shared'), eq(view.createdBy, userId)),
        ),
      )
      .orderBy(asc(view.name)),
  )
  return rows.map(toRow)
})

export type SaveViewInput = ViewTarget & {
  id?: string | undefined
  name: string
  filter: Array<Condition>
  sort: ViewSort
  columns: ViewColumns
  extra: ViewExtra
  visibility: 'shared' | 'private'
}

export const saveViewProgram = Effect.fn('saveViewProgram')(function* (
  input: SaveViewInput,
  actor: { id: string; isAdmin: boolean },
): Effect.fn.Return<ViewRow, ViewNotFound | ViewForbidden | ViewQueryFailed> {
  const name = input.name.trim()
  if (!name) return yield* new ViewForbidden({ message: 'Name the view' })
  if (input.id) {
    const existing = yield* query(() =>
      db
        .select()
        .from(view)
        .where(eq(view.id, input.id!))
        .then((rows) => rows.at(0)),
    )
    if (!existing)
      return yield* new ViewNotFound({
        id: input.id,
        message: 'View not found',
      })
    if (existing.createdBy !== actor.id && !actor.isAdmin)
      return yield* new ViewForbidden({
        message: 'Only the view’s author or an admin can change it',
      })
    const row = yield* query(() =>
      db
        .update(view)
        .set({
          name,
          filter: input.filter,
          sort: input.sort,
          columns: input.columns,
          extra: input.extra,
          visibility: input.visibility,
          updatedAt: new Date(),
        })
        .where(eq(view.id, input.id!))
        .returning()
        .then((rows) => rows[0]),
    )
    return toRow(row)
  }
  const row = yield* query(() =>
    db
      .insert(view)
      .values({
        surface: input.surface,
        objectId: input.surface === 'object' ? input.objectId : null,
        name,
        filter: input.filter,
        sort: input.sort,
        columns: input.columns,
        extra: input.extra,
        visibility: input.visibility,
        createdBy: actor.id,
      })
      .returning()
      .then((rows) => rows[0]),
  )
  return toRow(row)
})

export const deleteViewProgram = Effect.fn('deleteViewProgram')(function* (
  input: { id: string; surface: ViewSurface },
  actor: { id: string; isAdmin: boolean },
): Effect.fn.Return<
  { ok: true },
  ViewNotFound | ViewForbidden | ViewQueryFailed
> {
  const { id } = input
  const existing = yield* query(() =>
    db
      .select({ createdBy: view.createdBy, surface: view.surface })
      .from(view)
      .where(eq(view.id, id))
      .then((rows) => rows.at(0)),
  )
  // A surface may only delete its own views: /documents cannot reach a
  // companies view by guessing an id.
  if (!existing || existing.surface !== input.surface)
    return yield* new ViewNotFound({ id, message: 'View not found' })
  if (existing.createdBy !== actor.id && !actor.isAdmin)
    return yield* new ViewForbidden({
      message: 'Only the view’s author or an admin can delete it',
    })
  yield* query(() => db.delete(view).where(eq(view.id, id)))
  return { ok: true }
})
