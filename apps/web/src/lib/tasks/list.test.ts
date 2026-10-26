import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The /tasks read carries the focused task, against the test
 * database. Done is a 50-row window ordered by `done_at desc`, so a Cmd-K
 * hit on a task closed long ago is not in it — the program must fetch that
 * task by id rather than hope. `listTasksProgram` rather than the server fn:
 * `requireUser` reads a request the suite has no way to build. Dynamic
 * imports: `@spaces/db` builds its pool from `DATABASE_URL` at import time,
 * and the setup file rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** 51 closed tasks a minute apart, the oldest first; and one open task. */
async function seed() {
  const { db } = await import('@spaces/db')
  const { task } = await import('@spaces/db/schema/tasks')
  const actor = await actorId()
  const base = Date.parse('2026-09-01T12:00:00Z')
  const closed = await db
    .insert(task)
    .values(
      Array.from({ length: 51 }, (_, i) => ({
        content: `Closed ${i}`,
        assigneeId: actor,
        createdBy: actor,
        doneAt: new Date(base + i * 60_000),
      })),
    )
    .returning({ id: task.id, content: task.content })
  const oldest = closed.find((t) => t.content === 'Closed 0')
  expect(oldest).toBeTruthy()
  const [open] = await db
    .insert(task)
    .values({ content: 'Still open', assigneeId: actor, createdBy: actor })
    .returning({ id: task.id })
  return { oldest: oldest?.id ?? '', open: open.id }
}

async function list(input: {
  includeDone?: boolean
  focus?: string
  record?: string
}) {
  const { Effect } = await import('effect')
  const { listTasksProgram } = await import('./list')
  return Effect.runPromise(listTasksProgram(input))
}

describe('listTasks with a focused task', () => {
  // One seed for the file: isolation truncates per file, not per test.
  let seeded = { oldest: '', open: '' }
  beforeAll(async () => {
    seeded = await seed()
  })

  it('returns a closed task that falls outside the 50-row Done window', async () => {
    const { oldest } = seeded

    const unfocused = await list({ includeDone: true })
    expect(unfocused.done).toHaveLength(50)
    expect(unfocused.done.some((t) => t.id === oldest)).toBe(false)

    const focused = await list({ includeDone: true, focus: oldest })
    expect(focused.done).toHaveLength(51)
    // Appended last: it is older than every row in the window, so the
    // Done log still reads newest first.
    expect(focused.done.at(-1)?.id).toBe(oldest)
    expect(focused.done.at(-1)?.content).toBe('Closed 0')
    const doneAts = focused.done.map((t) => t.doneAt ?? '')
    expect(doneAts).toEqual([...doneAts].sort().reverse())
  })

  it('does not duplicate a task the payload already carries', async () => {
    const { open } = seeded
    const result = await list({ includeDone: true, focus: open })
    expect(result.open.filter((t) => t.id === open)).toHaveLength(1)
    expect(result.done).toHaveLength(50)
    expect(result.done.some((t) => t.id === open)).toBe(false)
  })

  it('renders an unknown id as no focus at all', async () => {
    const result = await list({ includeDone: true, focus: randomUUID() })
    expect(result.open).toHaveLength(1)
    expect(result.done).toHaveLength(50)
  })

  it('leaves Done empty when it was not asked for', async () => {
    const { oldest } = seeded
    const result = await list({ focus: oldest })
    expect(result.done).toEqual([])
  })
})

describe('listTasks narrowed to a record', () => {
  it('lists only the tasks linked to the record, open and done, and names it', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { task, taskEntity } = await import('@spaces/db/schema/tasks')
    const actor = await actorId()
    const [flent, other] = await db
      .insert(entity)
      .values([
        { kind: 'company', canonicalName: 'Flent' },
        { kind: 'company', canonicalName: 'Other Co' },
      ])
      .returning({ id: entity.id })
    const rows = await db
      .insert(task)
      .values([
        { content: 'Chase Flent', assigneeId: actor, createdBy: actor },
        {
          content: 'Closed on Flent',
          assigneeId: actor,
          createdBy: actor,
          doneAt: new Date(),
        },
        { content: 'Chase Other', assigneeId: actor, createdBy: actor },
        { content: 'Unlinked', assigneeId: actor, createdBy: actor },
      ])
      .returning({ id: task.id, content: task.content })
    const id = (content: string) =>
      rows.find((r) => r.content === content)?.id ?? ''
    await db.insert(taskEntity).values([
      { taskId: id('Chase Flent'), entityId: flent.id },
      { taskId: id('Closed on Flent'), entityId: flent.id },
      { taskId: id('Chase Other'), entityId: other.id },
    ])

    const narrowed = await list({ includeDone: true, record: flent.id })
    expect(narrowed.open.map((t) => t.content)).toEqual(['Chase Flent'])
    expect(narrowed.done.map((t) => t.content)).toEqual(['Closed on Flent'])
    expect(narrowed.record).toEqual({
      id: flent.id,
      name: 'Flent',
      kind: 'company',
    })

    const everything = await list({ includeDone: true })
    expect(everything.record).toBeNull()
    expect(everything.open.map((t) => t.content)).toEqual(
      expect.arrayContaining(['Chase Flent', 'Chase Other', 'Unlinked']),
    )
  })
})
