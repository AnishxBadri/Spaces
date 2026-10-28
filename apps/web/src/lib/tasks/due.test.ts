import { describe, expect, it } from 'vitest'
import { dueCount, overdueCount } from './due'

/**
 * The sidebar's `n due`: open tasks due today or overdue. The server hands
 * back days up to tomorrow; the browser counts against its own today.
 */

describe('dueCount', () => {
  it('counts overdue and today, never tomorrow', () => {
    const days = [
      { day: '2026-10-09', n: 2 },
      { day: '2026-10-11', n: 1 },
      { day: '2026-10-12', n: 4 },
    ]
    expect(dueCount(days, '2026-10-11')).toBe(3)
    expect(dueCount(days, '2026-10-12')).toBe(7)
    expect(dueCount([], '2026-10-11')).toBe(0)
  })
})

describe('overdueCount', () => {
  it('counts the days before today only', () => {
    const days = [
      { day: '2026-10-09', n: 2 },
      { day: '2026-10-11', n: 1 },
    ]
    expect(overdueCount(days, '2026-10-11')).toBe(2)
    expect(overdueCount(days, '2026-10-09')).toBe(0)
    expect(overdueCount(days, '2026-10-12')).toBe(3)
  })
})

describe('dueDaysProgram', () => {
  it('reads open dated tasks per day through tomorrow, leaving done, dateless and later ones out', async () => {
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { sql } = await import('drizzle-orm')
    const { task } = await import('@spaces/db/schema/tasks')
    const { user } = await import('@spaces/db/schema/auth')
    const { dueDaysProgram } = await import('./list')
    const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!actor) throw new Error('no fixture user')
    const day = async (offset: number) =>
      (
        await db.execute<{ d: string }>(
          sql`select (current_date + ${offset}::int)::text as d`,
        )
      ).rows[0].d
    const [yesterday, today, tomorrow, later] = await Promise.all([
      day(-1),
      day(0),
      day(1),
      day(5),
    ])
    const row = (content: string, dueDate: string | null, done = false) => ({
      content,
      dueDate,
      assigneeId: actor.id,
      createdBy: actor.id,
      doneAt: done ? new Date() : null,
    })
    await db
      .insert(task)
      .values([
        row('late', yesterday),
        row('late too', yesterday),
        row('today', today),
        row('tomorrow', tomorrow),
        row('later', later),
        row('dateless', null),
        row('closed', yesterday, true),
      ])
    const days = await Effect.runPromise(dueDaysProgram())
    expect([...days].sort((a, b) => a.day.localeCompare(b.day))).toEqual([
      { day: yesterday, n: 2 },
      { day: today, n: 1 },
      { day: tomorrow, n: 1 },
    ])
    expect(dueCount(days, today)).toBe(3)
  })
})
