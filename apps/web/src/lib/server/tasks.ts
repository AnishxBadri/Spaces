import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { task, taskEntity } from '@spaces/db/schema/tasks'
import { user } from '@spaces/db/schema/auth'
import { requireUser } from './shared'

/**
 * Tasks. Any member sees and completes any task — a
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
    const { insertTaskInTx } = await import('#/lib/tasks/create')
    return db.transaction((tx) =>
      insertTaskInTx(tx, {
        content: data.content,
        dueDate: data.dueDate ?? null,
        assigneeId: data.assigneeId ?? u.id,
        createdBy: u.id,
        entityIds: data.entityIds ?? [],
      }),
    )
  })

/**
 * Open tasks, and — with `includeDone` — the Done window; `record` narrows
 * both to the tasks linked to one record. `focus` is the
 * task a `/tasks?task=<id>` link lands on; the payload carries it even when
 * it closed too long ago to sit in the window. The read states its own
 * invariants and lives outside the server-fn modules so a test can call it
 * without a request; this is the request half only.
 */
export const listTasks = createServerFn()
  .validator(
    z
      .object({
        includeDone: z.boolean().optional(),
        focus: z.string().uuid().optional(),
        record: z.string().uuid().optional(),
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
      record: data?.record,
    })
  })

/** Open tasks per due day, overdue through tomorrow: the sidebar's `n due`. */
export const listDueTaskDays = createServerFn().handler(async () => {
  await requireUser()
  const { dueDaysProgram } = await import('#/lib/tasks/list')
  const { effectFn } = await import('./effect')
  return effectFn(dueDaysProgram)()
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

/** A task's due day, set or cleared from its row's `···`. */
export const setTaskDue = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), dueDate: isoDate.nullable() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { setTaskDueProgram } = await import('#/lib/tasks/edit')
    const { effectFn } = await import('./effect')
    return effectFn(setTaskDueProgram)(data.id, data.dueDate)
  })

/** Hand a task to another member, from its row's `···`. */
export const setTaskAssignee = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), assigneeId: z.string().min(1) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { setTaskAssigneeProgram } = await import('#/lib/tasks/edit')
    const { effectFn } = await import('./effect')
    return effectFn(setTaskAssigneeProgram)(data.id, data.assigneeId)
  })

export const deleteTask = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db.delete(task).where(eq(task.id, data.id))
    return { ok: true }
  })
