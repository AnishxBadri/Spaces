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

export async function insertTaskInTx(
  tx: Tx,
  input: NewTask,
): Promise<{ id: string }> {
  const row = (
    await tx
      .insert(task)
      .values({
        content: input.content,
        dueDate: input.dueDate,
        assigneeId: input.assigneeId,
        createdBy: input.createdBy,
      })
      .returning({ id: task.id })
  ).at(0)
  if (!row) throw new Error('task insert returned no row')
  const entityIds = [...new Set(input.entityIds)]
  if (entityIds.length > 0)
    await tx
      .insert(taskEntity)
      .values(entityIds.map((entityId) => ({ taskId: row.id, entityId })))
  return { id: row.id }
}
