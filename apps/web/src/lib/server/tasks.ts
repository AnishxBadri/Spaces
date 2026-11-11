import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { task, taskEntity } from '@spaces/db/schema/tasks'
import { user } from '@spaces/db/schema/auth'
import { requireUser } from './shared'
import { input } from './input'

/**
 * Tasks. Any member sees and completes any task — a
 * two-person fund has no private to-do lists; personal filtering is the
 * client's "mine" scope, not a permission.
 */

const isoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expected YYYY-MM-DD' }),
)

const uuid = Schema.String.check(Schema.isUUID())

class TaskQueryFailed extends Schema.TaggedError<TaskQueryFailed>()(
  'TaskQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TaskQueryFailed({ cause }),
  })

export const createTask = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        content: Schema.Trim.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(500),
        ),
        dueDate: Schema.optional(Schema.NullOr(isoDate)),
        assigneeId: Schema.optional(Schema.String),
        entityIds: Schema.optional(
          Schema.Array(uuid).check(Schema.isMaxLength(10)),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { createTaskProgram } = await import('#/lib/tasks/create')
    const { effectFn } = await import('./effect')
    return effectFn(createTaskProgram)({
      content: data.content,
      dueDate: data.dueDate ?? null,
      assigneeId: data.assigneeId ?? u.id,
      createdBy: u.id,
      entityIds: data.entityIds ?? [],
    })
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
    input(
      Schema.UndefinedOr(
        Schema.Struct({
          includeDone: Schema.optional(Schema.Boolean),
          focus: Schema.optional(uuid),
          record: Schema.optional(uuid),
        }),
      ),
    ),
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

const listEntityTasksProgram = Effect.fn('listEntityTasksProgram')(function* (
  entityId: string,
) {
  return yield* query(() =>
    db
      .select({
        id: task.id,
        content: task.content,
        dueDate: task.dueDate,
        assigneeName: user.name,
      })
      .from(taskEntity)
      .innerJoin(task, eq(task.id, taskEntity.taskId))
      .innerJoin(user, eq(user.id, task.assigneeId))
      .where(and(eq(taskEntity.entityId, entityId), isNull(task.doneAt)))
      .orderBy(asc(task.dueDate)),
  )
})

export const listEntityTasks = createServerFn()
  .validator(input(Schema.Struct({ entityId: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    const { effectFn } = await import('./effect')
    return effectFn(listEntityTasksProgram)(data.entityId)
  })

const setTaskDoneProgram = Effect.fn('setTaskDoneProgram')(function* (
  id: string,
  done: boolean,
) {
  yield* query(() =>
    db
      .update(task)
      .set({ doneAt: done ? new Date() : null })
      .where(eq(task.id, id)),
  )
  return { ok: true }
})

export const setTaskDone = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid, done: Schema.Boolean })))
  .handler(async ({ data }) => {
    await requireUser()
    const { effectFn } = await import('./effect')
    return effectFn(setTaskDoneProgram)(data.id, data.done)
  })

/** A task's due day, set or cleared from its row's `···`. */
export const setTaskDue = createServerFn({ method: 'POST' })
  .validator(
    input(Schema.Struct({ id: uuid, dueDate: Schema.NullOr(isoDate) })),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { setTaskDueProgram } = await import('#/lib/tasks/edit')
    const { effectFn } = await import('./effect')
    return effectFn(setTaskDueProgram)(data.id, data.dueDate)
  })

/** Hand a task to another member, from its row's `···`. */
export const setTaskAssignee = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: uuid,
        assigneeId: Schema.String.check(Schema.isMinLength(1)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { setTaskAssigneeProgram } = await import('#/lib/tasks/edit')
    const { effectFn } = await import('./effect')
    return effectFn(setTaskAssigneeProgram)(data.id, data.assigneeId)
  })

const deleteTaskProgram = Effect.fn('deleteTaskProgram')(function* (
  id: string,
) {
  yield* query(() => db.delete(task).where(eq(task.id, id)))
  return { ok: true }
})

export const deleteTask = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    const { effectFn } = await import('./effect')
    return effectFn(deleteTaskProgram)(data.id)
  })
