import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'
import { requireUser } from './shared'

const condition = z.object({
  slug: z.string().min(1).max(80),
  op: z.enum(['is', 'is_not', 'contains', 'empty', 'not_empty', 'gt', 'lt']),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])
    .optional(),
})

const objectKey = z
  .object({
    kind: z.enum(['company', 'person', 'deal']).optional(),
    objectId: z.string().uuid().optional(),
  })
  .refine((v) => v.kind || v.objectId, {
    message: 'Give a kind or an objectId',
  })

const resolveObjectId = async (key: {
  kind?: 'company' | 'person' | 'deal' | undefined
  objectId?: string | undefined
}) => {
  if (key.objectId) return key.objectId
  const { objectIdForKindAsync } = await import('../attributes/objects')
  return objectIdForKindAsync(key.kind ?? 'company')
}

export const listViews = createServerFn()
  .validator(objectKey)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { listViewsProgram } = await import('../views/store')
    const objectId = await resolveObjectId(data)
    const views = await Effect.runPromise(listViewsProgram(objectId, u.id))
    return { objectId, views }
  })

export const saveView = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid().optional(),
      objectId: z.string().uuid(),
      name: z.string().trim().min(1).max(80),
      filter: z.array(condition).max(20),
      sort: z.object({ id: z.string(), desc: z.boolean() }).nullable(),
      columns: z.record(z.string(), z.boolean()),
      extra: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      ),
      visibility: z.enum(['shared', 'private']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { saveViewProgram } = await import('../views/store')
    const { effectFn } = await import('./effect')
    return effectFn(saveViewProgram)(data, {
      id: u.id,
      isAdmin: u.role === 'admin',
    })
  })

export const deleteView = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { deleteViewProgram } = await import('../views/store')
    const { effectFn } = await import('./effect')
    return effectFn(deleteViewProgram)(data.id, {
      id: u.id,
      isAdmin: u.role === 'admin',
    })
  })
