import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * The task writer against the test database. Dynamic imports: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time, and the setup file
 * rewrites it per file.
 */

async function fixtures() {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const { entity } = await import('@spaces/db/schema')
  const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!actor) throw new Error('seed is missing its user')
  const record = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: 'Acme' })
      .returning({ id: entity.id })
  ).at(0)
  if (!record) throw new Error('no record')
  return { actor: actor.id, record: record.id }
}

describe('createTaskProgram', () => {
  it('writes the task and one link per distinct record', async () => {
    const { db } = await import('@spaces/db')
    const { task, taskEntity } = await import('@spaces/db/schema/tasks')
    const { eq } = await import('drizzle-orm')
    const { createTaskProgram } = await import('./create')
    const { actor, record } = await fixtures()

    const { id } = await Effect.runPromise(
      createTaskProgram({
        content: 'Send the term sheet',
        dueDate: '2026-11-20',
        assigneeId: actor,
        createdBy: actor,
        entityIds: [record, record],
      }),
    )

    const rows = await db.select().from(task).where(eq(task.id, id))
    expect(rows.map((r) => [r.content, r.dueDate])).toEqual([
      ['Send the term sheet', '2026-11-20'],
    ])
    const links = await db
      .select({ entityId: taskEntity.entityId })
      .from(taskEntity)
      .where(eq(taskEntity.taskId, id))
    expect(links).toEqual([{ entityId: record }])
  })

  it('writes nothing when a link fails, and fails tagged', async () => {
    const { db } = await import('@spaces/db')
    const { task } = await import('@spaces/db/schema/tasks')
    const { eq } = await import('drizzle-orm')
    const { createTaskProgram, TaskInsertFailed } = await import('./create')
    const { actor } = await fixtures()

    const failed = await Effect.runPromise(
      Effect.flip(
        createTaskProgram({
          content: 'Linked to nothing',
          dueDate: null,
          assigneeId: actor,
          createdBy: actor,
          entityIds: [randomUUID()],
        }),
      ),
    )
    expect(failed).toBeInstanceOf(TaskInsertFailed)
    const rows = await db
      .select({ id: task.id })
      .from(task)
      .where(eq(task.content, 'Linked to nothing'))
    expect(rows).toEqual([])
  })
})

describe('insertTaskInTx', () => {
  it("writes inside the caller's transaction and rolls back with it", async () => {
    const { db } = await import('@spaces/db')
    const { task } = await import('@spaces/db/schema/tasks')
    const { eq } = await import('drizzle-orm')
    const { insertTaskInTx } = await import('./create')
    const { actor } = await fixtures()

    const rolledBack = db.transaction(async (tx) => {
      await insertTaskInTx(tx, {
        content: 'Undone with its caller',
        dueDate: null,
        assigneeId: actor,
        createdBy: actor,
        entityIds: [],
      })
      throw new Error('caller gives up')
    })
    await expect(rolledBack).rejects.toThrow('caller gives up')
    const rows = await db
      .select({ id: task.id })
      .from(task)
      .where(eq(task.content, 'Undone with its caller'))
    expect(rows).toEqual([])
  })
})
