import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { task } from '@spaces/db/schema/tasks'
import { user } from '@spaces/db/schema/auth'

/**
 * A task row's `···` edits: its due date and its assignee. Outside the
 * server-fn modules so a test can run them without a request. Any member
 * edits any task, as any member completes one.
 */

export class TaskEditFailed extends Schema.TaggedError<TaskEditFailed>()(
  'TaskEditFailed',
  { cause: Schema.Defect() },
) {}

/** The id names no task, or the assignee no member. */
export class TaskEditRefused extends Schema.TaggedError<TaskEditRefused>()(
  'TaskEditRefused',
  { message: Schema.String },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TaskEditFailed({ cause }),
  })

const updated = (rows: ReadonlyArray<{ id: string }>) =>
  rows.length === 0
    ? Effect.fail(new TaskEditRefused({ message: 'Task not found' }))
    : Effect.succeed({ ok: true as const })

/** Set or clear a task's due day (`YYYY-MM-DD`); dateless is legal. */
export const setTaskDueProgram = Effect.fn('setTaskDueProgram')(function* (
  id: string,
  dueDate: string | null,
) {
  const rows = yield* query(() =>
    db
      .update(task)
      .set({ dueDate })
      .where(eq(task.id, id))
      .returning({ id: task.id }),
  )
  return yield* updated(rows)
})

/** Hand a task to a member; every task has one, so there is no clear. */
export const setTaskAssigneeProgram = Effect.fn('setTaskAssigneeProgram')(
  function* (id: string, assigneeId: string) {
    const member = yield* query(() =>
      db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, assigneeId))
        .limit(1),
    )
    if (member.length === 0)
      return yield* Effect.fail(
        new TaskEditRefused({ message: 'No such member' }),
      )
    const rows = yield* query(() =>
      db
        .update(task)
        .set({ assigneeId })
        .where(eq(task.id, id))
        .returning({ id: task.id }),
    )
    return yield* updated(rows)
  },
)
