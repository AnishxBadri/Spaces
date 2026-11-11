import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { task, taskEntity } from '@spaces/db/schema/tasks'
import type { Tx } from '@spaces/core/writes/attributes/values'

/**
 * The task writer: one `task` row and its record links, inside the caller's
 * transaction. `createTask` and the `task` suggestion's accept both write
 * through it.
 */
export type NewTask = {
  content: string
  /** `YYYY-MM-DD`, or null for a dateless task. */
  dueDate: string | null
  assigneeId: string
  createdBy: string
  entityIds: ReadonlyArray<string>
}

export class TaskInsertFailed extends Schema.TaggedError<TaskInsertFailed>()(
  'TaskInsertFailed',
  { cause: Schema.Defect() },
) {}

/** The insert came back without the row it wrote. */
export class TaskRowMissing extends Schema.TaggedError<TaskRowMissing>()(
  'TaskRowMissing',
  { message: Schema.String },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TaskInsertFailed({ cause }),
  })

export const insertTaskProgram = Effect.fn('insertTaskProgram')(function* (
  tx: Tx,
  input: NewTask,
) {
  const row = (yield* query(() =>
    tx
      .insert(task)
      .values({
        content: input.content,
        dueDate: input.dueDate,
        assigneeId: input.assigneeId,
        createdBy: input.createdBy,
      })
      .returning({ id: task.id }),
  )).at(0)
  if (!row)
    return yield* new TaskRowMissing({
      message: 'task insert returned no row',
    })
  const entityIds = [...new Set(input.entityIds)]
  if (entityIds.length > 0)
    yield* query(() =>
      tx
        .insert(taskEntity)
        .values(entityIds.map((entityId) => ({ taskId: row.id, entityId }))),
    )
  return { id: row.id }
})

/** `insertTaskProgram` for a caller that is not Effect. */
export const insertTaskInTx = (
  tx: Tx,
  input: NewTask,
): Promise<{ id: string }> => Effect.runPromise(insertTaskProgram(tx, input))

/** `createTask`'s write: the task and its links in one transaction. */
export const createTaskProgram = Effect.fn('createTaskProgram')(function* (
  input: NewTask,
) {
  // The writer's own failures come out of the transaction already tagged;
  // only what drizzle throws around them (begin, commit) is wrapped here.
  return yield* Effect.tryPromise({
    try: () => db.transaction((tx) => insertTaskInTx(tx, input)),
    catch: (cause) =>
      cause instanceof TaskRowMissing || cause instanceof TaskInsertFailed
        ? cause
        : new TaskInsertFailed({ cause }),
  })
})
