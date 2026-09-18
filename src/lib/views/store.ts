import { Effect, Schema } from 'effect'
import { and, asc, eq, or } from 'drizzle-orm'
import { db } from '#/db'
import { view } from '#/db/schema'
import type { Condition, ViewExtra, ViewSort } from './filter'
import type { ViewColumns } from '#/db/schema/views'

export type { ViewSort }

/**
 * Views, the write side (Effect-first). Anyone may create a view, private
 * or shared; only its author or an admin may change or delete it. Views
 * reference the object row, never an entity, so the merge executor stays
 * out of it.
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
  objectId: string
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

/** Shared views plus the caller's private ones, name order. */
export const listViewsProgram = Effect.fn('listViewsProgram')(function* (
  objectId: string,
  userId: string,
): Effect.fn.Return<Array<ViewRow>, ViewQueryFailed> {
  const rows = yield* query(() =>
    db
      .select()
      .from(view)
      .where(
        and(
          eq(view.objectId, objectId),
          or(eq(view.visibility, 'shared'), eq(view.createdBy, userId)),
        ),
      )
      .orderBy(asc(view.name)),
  )
  return rows.map(toRow)
})

export type SaveViewInput = {
  id?: string | undefined
  objectId: string
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
        objectId: input.objectId,
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
  id: string,
  actor: { id: string; isAdmin: boolean },
): Effect.fn.Return<
  { ok: true },
  ViewNotFound | ViewForbidden | ViewQueryFailed
> {
  const existing = yield* query(() =>
    db
      .select({ createdBy: view.createdBy })
      .from(view)
      .where(eq(view.id, id))
      .then((rows) => rows.at(0)),
  )
  if (!existing)
    return yield* new ViewNotFound({ id, message: 'View not found' })
  if (existing.createdBy !== actor.id && !actor.isAdmin)
    return yield* new ViewForbidden({
      message: 'Only the view’s author or an admin can delete it',
    })
  yield* query(() => db.delete(view).where(eq(view.id, id)))
  return { ok: true }
})
