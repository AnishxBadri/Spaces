import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { task, taskEntity } from '@spaces/db/schema/tasks'
import { user } from '@spaces/db/schema/auth'
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

/**
 * Open tasks, and — with `includeDone` — the Done window. `focus` is the
 * task a `/tasks?task=<id>` link lands on; the payload carries it even when
 * it closed too long ago to sit in the window. The read and its invariants
 * live in `lib/tasks/list.ts`, outside `lib/server/` so a test can call it
 * without a request; this is the request half only.
 */
export const listTasks = createServerFn()
  .validator(
    z
      .object({
        includeDone: z.boolean().optional(),
        focus: z.string().uuid().optional(),
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { listTasksProgram } = await import('#/lib/tasks/list')
    const { effectFn } = await import('./effect')
    return effectFn(listTasksProgram)({
      includeDone: data?.includeDone,
      focus: data?.focus,
    })
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
