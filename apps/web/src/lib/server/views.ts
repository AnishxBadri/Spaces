import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { finite, uuidString } from '@spaces/core/attributes/registry'
import {
  documentKeyFields,
  exactlyOneObjectRefMessage,
  objectKeyFields,
  oneObjectRef,
  surfaceKey,
} from '@spaces/core/views/target'
import type { SurfaceKey, ViewTarget } from '@spaces/core/views/target'
import { plainRecord } from '../plain-record'
import type { ViewCount } from '../views/counts'
import { input } from './input'
import { requireUser } from './shared'

const finiteNumber = Schema.Number.check(finite)

const condition = Schema.Struct({
  slug: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  op: Schema.Literals([
    'is',
    'is_not',
    'contains',
    'empty',
    'not_empty',
    'gt',
    'lt',
  ]),
  value: Schema.optional(
    Schema.Union([
      Schema.String,
      finiteNumber,
      Schema.Boolean,
      Schema.Null,
      Schema.mutable(Schema.Array(Schema.String)),
    ]),
  ),
})

const conditions = Schema.mutable(Schema.Array(condition)).check(
  Schema.isMaxLength(20),
)

const viewBody = {
  id: Schema.optional(uuidString),
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  filter: conditions,
  sort: Schema.NullOr(
    Schema.Struct({ id: Schema.String, desc: Schema.Boolean }),
  ),
  columns: plainRecord(Schema.Boolean),
  extra: plainRecord(
    Schema.Union([Schema.String, finiteNumber, Schema.Boolean, Schema.Null]),
  ),
  visibility: Schema.Literals(['shared', 'private']),
}

const saveKey = Schema.Union([
  Schema.Struct({ ...objectKeyFields, ...viewBody }).check(oneObjectRef),
  Schema.Struct({ ...documentKeyFields, ...viewBody }),
])

const deleteKey = Schema.Union([
  Schema.Struct({ ...objectKeyFields, id: uuidString }).check(oneObjectRef),
  Schema.Struct({ ...documentKeyFields, id: uuidString }),
])

/**
 * Key → target: the object surface resolves its kind to an object row; every
 * other surface names none. There is no default kind — a key that supplies
 * neither kind nor objectId never reaches here, because the validators above
 * refuse it.
 */
const resolveTarget = async (key: SurfaceKey): Promise<ViewTarget> => {
  if (key.surface === 'document') return { surface: 'document' }
  if (key.objectId !== undefined)
    return { surface: 'object', objectId: key.objectId }
  if (key.kind === undefined)
    throw new Error(exactlyOneObjectRefMessage.message)
  const { objectIdForKindAsync } =
    await import('@spaces/core/writes/attributes/objects')
  return { surface: 'object', objectId: await objectIdForKindAsync(key.kind) }
}

export const listViews = createServerFn()
  .validator(input(surfaceKey))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { listViewsProgram } = await import('@spaces/core/writes/views/store')
    const target = await resolveTarget(data)
    const views = await Effect.runPromise(listViewsProgram(target, u.id))
    // Null on a surface with no object row — the same equivalence the
    // `view_surface_object_id` CHECK asserts, so the page rebuilds the target
    // from it with `viewTarget`.
    return {
      objectId: target.surface === 'object' ? target.objectId : null,
      views,
    }
  })

export const saveView = createServerFn({ method: 'POST' })
  .validator(input(saveKey))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { saveViewProgram } = await import('@spaces/core/writes/views/store')
    const { effectFn } = await import('./effect')
    const target = await resolveTarget(data)
    return effectFn(saveViewProgram)(
      {
        ...target,
        id: data.id,
        name: data.name,
        filter: data.filter,
        sort: data.sort,
        columns: data.columns,
        extra: data.extra,
        visibility: data.visibility,
      },
      { id: u.id, isAdmin: u.role === 'admin' },
    )
  })

export const deleteView = createServerFn({ method: 'POST' })
  .validator(input(deleteKey))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { deleteViewProgram } =
      await import('@spaces/core/writes/views/store')
    const { effectFn } = await import('./effect')
    return effectFn(deleteViewProgram)(
      { id: data.id, surface: data.surface },
      { id: u.id, isAdmin: u.role === 'admin' },
    )
  })

/**
 * The sidebar's pinned views: of the ids this browser pinned, the ones the
 * caller may read, each with its object's slug. A pin missing from the answer
 * is pruned by the sidebar.
 */
export const listPinnedViews = createServerFn()
  .validator(
    input(
      Schema.Struct({
        ids: Schema.mutable(Schema.Array(uuidString)).check(
          Schema.isMaxLength(100),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { pinnedViewsProgram } = await import('../views/pinned')
    const { effectFn } = await import('./effect')
    return effectFn(pinnedViewsProgram)({ id: u.id }, data.ids)
  })

/** Cmd-K's Jump to: every saved view the caller may open, with its list. */
export const listJumpViews = createServerFn().handler(async () => {
  const u = await requireUser()
  const { jumpViewsProgram } = await import('../views/jump')
  const { effectFn } = await import('./effect')
  return effectFn(jumpViewsProgram)({ id: u.id })
})

/**
 * The view chips' counts: one call per page for every chip on the
 * bar. `live` carries the conditions the page is showing for its active view
 * when they differ from the saved ones, so that chip moves with the table.
 *
 * **Object surfaces only.** The document surface is excluded on purpose:
 * its fields are columns and edges, there is no `entity.values` for
 * `entityValuesResolver` to read, and counting it would take a
 * column-backed `FieldResolver` of its own.
 */
export const countViews = createServerFn()
  .validator(
    input(
      Schema.Struct({
        ...objectKeyFields,
        viewIds: Schema.mutable(Schema.Array(uuidString)).check(
          Schema.isMaxLength(100),
        ),
        live: Schema.optional(
          Schema.Struct({ viewId: uuidString, filter: conditions }),
        ),
      }).check(oneObjectRef),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { countViewsProgram } = await import('../views/counts')
    const { effectFn } = await import('./effect')
    const target = await resolveTarget(data)
    const none: Record<string, ViewCount> = {}
    if (target.surface !== 'object') return none
    return effectFn(countViewsProgram)(
      target.objectId,
      data.viewIds,
      u.id,
      data.live,
    )
  })
