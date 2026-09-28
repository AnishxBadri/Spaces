import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'
import {
  documentKeyFields,
  exactlyOneObjectRef,
  exactlyOneObjectRefMessage,
  objectKeyFields,
  surfaceKey,
} from '../views/target'
import type { SurfaceKey, ViewTarget } from '../views/target'
import type { ViewCount } from '../views/counts'
import { requireUser } from './shared'

const condition = z.object({
  slug: z.string().min(1).max(80),
  op: z.enum(['is', 'is_not', 'contains', 'empty', 'not_empty', 'gt', 'lt']),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])
    .optional(),
})

const viewBody = {
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  filter: z.array(condition).max(20),
  sort: z.object({ id: z.string(), desc: z.boolean() }).nullable(),
  columns: z.record(z.string(), z.boolean()),
  extra: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
  visibility: z.enum(['shared', 'private']),
}

const saveKey = z.discriminatedUnion('surface', [
  z
    .object({ ...objectKeyFields, ...viewBody })
    .refine(exactlyOneObjectRef, exactlyOneObjectRefMessage),
  z.object({ ...documentKeyFields, ...viewBody }),
])

const deleteKey = z.discriminatedUnion('surface', [
  z
    .object({ ...objectKeyFields, id: z.string().uuid() })
    .refine(exactlyOneObjectRef, exactlyOneObjectRefMessage),
  z.object({ ...documentKeyFields, id: z.string().uuid() }),
])

/**
 * Key → target: the object surface resolves its kind to an object row; every
 * other surface names none. There is no default kind — a key that supplies
 * neither kind nor objectId never reaches here, because the validators above
 * refuse it (D2, views-1).
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
  .validator(surfaceKey)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { listViewsProgram } = await import('../views/store')
    const target = await resolveTarget(data)
    const views = await Effect.runPromise(listViewsProgram(target, u.id))
    // Null on a surface with no object row — the same equivalence the
    // `view_surface_object_id` CHECK asserts, so the page rebuilds the target
    // from it with `viewTarget` (lib/views/target.ts).
    return {
      objectId: target.surface === 'object' ? target.objectId : null,
      views,
    }
  })

export const saveView = createServerFn({ method: 'POST' })
  .validator(saveKey)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { saveViewProgram } = await import('../views/store')
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
  .validator(deleteKey)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { deleteViewProgram } = await import('../views/store')
    const { effectFn } = await import('./effect')
    return effectFn(deleteViewProgram)(
      { id: data.id, surface: data.surface },
      { id: u.id, isAdmin: u.role === 'admin' },
    )
  })

/**
 * The view chips' counts (SPA-162): one call per page for every chip on the
 * bar. `live` carries the conditions the page is showing for its active view
 * when they differ from the saved ones, so that chip moves with the table.
 *
 * **Object surfaces only.** `/documents` is excluded by this validator, not
 * by an oversight: its registry is synthetic (docsurf-12b,
 * `lib/documents/registry.ts`) — its fields are columns and edges projected
 * in the browser, there is no `entity.values` for `entityValuesResolver` to
 * read, and its conditions do not compile through `compileConditions`
 * today. Counting it would take a column-backed `FieldResolver` for the
 * shelf, which is a surface resolver of its own, not a count.
 */
export const countViews = createServerFn()
  .validator(
    z.discriminatedUnion('surface', [
      z
        .object({
          ...objectKeyFields,
          viewIds: z.array(z.string().uuid()).max(100),
          live: z
            .object({
              viewId: z.string().uuid(),
              filter: z.array(condition).max(20),
            })
            .optional(),
        })
        .refine(exactlyOneObjectRef, exactlyOneObjectRefMessage),
    ]),
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
