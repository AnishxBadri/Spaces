import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The `task` suggestion: an action item accepts into one task row through
 * the task writer, with the accepter as creator and the suggestion closed;
 * a reject closes the row and writes no task.
 */

async function setup() {
  const { resolveEntity } = await import('@spaces/core/writes/entities/resolve')
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const accepter = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!accepter) throw new Error('the test seed has no user')
  const tag = randomUUID().slice(0, 8)
  const company = await resolveEntity({
    kind: 'company',
    name: `Action item ${tag}`,
    source: { class: 'manual' },
  })
  return { accepter, entityId: company.entityId, tag }
}

async function tasksTitled(title: string) {
  const { db } = await import('@spaces/db')
  const { task } = await import('@spaces/db/schema/tasks')
  const { eq } = await import('drizzle-orm')
  return db.select().from(task).where(eq(task.content, title))
}

describe('task suggestion', () => {
  it('accepts into one task row by the accepter, linked to the record, and closes', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram } =
      await import('@spaces/core/writes/suggestions/propose')
    const { acceptProgram } = await import('./propose')
    const { db } = await import('@spaces/db')
    const { taskEntity } = await import('@spaces/db/schema/tasks')
    const { eq } = await import('drizzle-orm')
    const { accepter, entityId, tag } = await setup()
    const title = `Send the data room ${tag}`

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'task',
        payload: { title, due: '2026-10-15', entity_id: entityId },
        proposedBy: { type: 'system' },
      }),
    )
    expect(proposed.status).toBe('open')
    expect(await tasksTitled(title)).toEqual([])

    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, { type: 'user', id: accepter.id }),
    )
    if (accepted.kind !== 'task') throw new Error('expected a task accept')
    expect(accepted.suggestion.status).toBe('accepted')
    expect(accepted.suggestion.decidedBy).toBe(accepter.id)

    const rows = await tasksTitled(title)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: accepted.taskId,
      dueDate: '2026-10-15',
      createdBy: accepter.id,
      assigneeId: accepter.id,
      doneAt: null,
    })
    const links = await db
      .select({ entityId: taskEntity.entityId })
      .from(taskEntity)
      .where(eq(taskEntity.taskId, accepted.taskId))
    expect(links).toEqual([{ entityId }])
  })

  it('rejects without writing a task', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram } =
      await import('@spaces/core/writes/suggestions/propose')
    const { rejectProgram } = await import('./propose')
    const { accepter, entityId, tag } = await setup()
    const title = `Chase the cap table ${tag}`

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'task',
        payload: { title, due: null, entity_id: entityId },
        proposedBy: { type: 'system' },
      }),
    )
    const rejected = await Effect.runPromise(
      rejectProgram(proposed.id, { type: 'user', id: accepter.id }),
    )
    expect(rejected.status).toBe('rejected')
    expect(await tasksTitled(title)).toEqual([])
  })

  it('refuses a payload with no title at propose', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram, SuggestionInvalid } =
      await import('@spaces/core/writes/suggestions/propose')
    const { entityId } = await setup()

    const failure = await Effect.runPromise(
      Effect.flip(
        proposeProgram({
          entityId,
          kind: 'task',
          payload: { title: '', due: null, entity_id: entityId },
          proposedBy: { type: 'system' },
        }),
      ),
    )
    expect(failure).toBeInstanceOf(SuggestionInvalid)
  })
})
