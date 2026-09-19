import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { entity } from '#/db/schema'
import { task, taskEntity } from '#/db/schema/tasks'
import { user } from '#/db/schema/auth'
import { requireUser } from './shared'

/**
 * Tasks (CONTEXT.md 15b). Any member sees and completes any task — a
 * two-person fund has no private to-do lists; personal filtering is the
 * client's "mine" scope, not a permission.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

export const createTask = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      content: z.string().trim().min(1).max(500),
      dueDate: isoDate.nullable().optional(),
      assigneeId: z.string().optional(),
      entityIds: z.array(z.string().uuid()).max(10).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(task)
        .values({
          content: data.content,
          dueDate: data.dueDate ?? null,
          assigneeId: data.assigneeId ?? u.id,
          createdBy: u.id,
        })
        .returning({ id: task.id })
      if (data.entityIds && data.entityIds.length > 0) {
        await tx
          .insert(taskEntity)
          .values(
            data.entityIds.map((entityId) => ({ taskId: row.id, entityId })),
          )
      }
      return { id: row.id }
    })
  })

async function linkedEntities(taskIds: Array<string>) {
  if (taskIds.length === 0)
    return new Map<string, Array<{ id: string; name: string; kind: string }>>()
  const rows = await db
    .select({
      taskId: taskEntity.taskId,
      id: entity.id,
      name: entity.canonicalName,
      kind: entity.kind,
    })
    .from(taskEntity)
    .innerJoin(entity, eq(entity.id, taskEntity.entityId))
    .where(inArray(taskEntity.taskId, taskIds))
  const map = new Map<
    string,
    Array<{ id: string; name: string; kind: string }>
  >()
  for (const r of rows) {
    const list = map.get(r.taskId) ?? []
    list.push({ id: r.id, name: r.name, kind: r.kind })
    map.set(r.taskId, list)
  }
  return map
}

const taskColumns = {
  id: task.id,
  content: task.content,
  dueDate: task.dueDate,
  assigneeId: task.assigneeId,
  assigneeName: user.name,
  doneAt: task.doneAt,
  createdAt: task.createdAt,
}

export const listTasks = createServerFn()
  .validator(z.object({ includeDone: z.boolean().optional() }).optional())
  .handler(async ({ data }) => {
    await requireUser()
    const open = await db
      .select(taskColumns)
      .from(task)
      .innerJoin(user, eq(user.id, task.assigneeId))
      .where(isNull(task.doneAt))
      .orderBy(asc(task.dueDate), asc(task.createdAt))
    const done = data?.includeDone
      ? await db
          .select(taskColumns)
          .from(task)
          .innerJoin(user, eq(user.id, task.assigneeId))
          .where(isNotNull(task.doneAt))
          .orderBy(desc(task.doneAt))
          .limit(50)
      : []
    const all = [...open, ...done]
    const links = await linkedEntities(all.map((t) => t.id))
    const serialize = (t: (typeof all)[number]) => ({
      ...t,
      doneAt: t.doneAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      entities: links.get(t.id) ?? [],
    })
    return { open: open.map(serialize), done: done.map(serialize) }
  })

export const listEntityTasks = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select({
        id: task.id,
        content: task.content,
        dueDate: task.dueDate,
        assigneeName: user.name,
      })
      .from(taskEntity)
      .innerJoin(task, eq(task.id, taskEntity.taskId))
      .innerJoin(user, eq(user.id, task.assigneeId))
      .where(and(eq(taskEntity.entityId, data.entityId), isNull(task.doneAt)))
      .orderBy(asc(task.dueDate))
    return rows
  })

export const setTaskDone = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), done: z.boolean() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db
      .update(task)
      .set({ doneAt: data.done ? new Date() : null })
      .where(eq(task.id, data.id))
    return { ok: true }
  })

export const deleteTask = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db.delete(task).where(eq(task.id, data.id))
    return { ok: true }
  })
