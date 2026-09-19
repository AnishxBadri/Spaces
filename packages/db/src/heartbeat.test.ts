import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from './index.ts'
import { workerHeartbeat } from './schema/worker.ts'
import {
  BEAT_EVERY_MS,
  STALE_AFTER,
  beat,
  classifyBeat,
  readLastBeat,
} from './heartbeat.ts'

const now = new Date('2026-09-19T12:00:00.000Z')
const secondsAgo = (n: number) => new Date(now.getTime() - n * 1000)

describe('classifyBeat', () => {
  it('reports absent with a null age when there is no row', () => {
    expect(classifyBeat(null, now, STALE_AFTER)).toEqual({
      status: 'absent',
      lastBeatSeconds: null,
    })
  })

  it('reports ok with the age for a fresh beat', () => {
    expect(classifyBeat(secondsAgo(12), now, STALE_AFTER)).toEqual({
      status: 'ok',
      lastBeatSeconds: 12,
    })
  })

  it('is ok at exactly the threshold and stale one second past it', () => {
    expect(classifyBeat(secondsAgo(STALE_AFTER), now, STALE_AFTER).status).toBe(
      'ok',
    )
    expect(
      classifyBeat(secondsAgo(STALE_AFTER + 1), now, STALE_AFTER).status,
    ).toBe('stale')
  })

  it('reports stale with the real age — the row is never deleted', () => {
    expect(classifyBeat(secondsAgo(90), now, STALE_AFTER)).toEqual({
      status: 'stale',
      lastBeatSeconds: 90,
    })
  })

  it('clamps a beat that clock skew puts in the future', () => {
    expect(classifyBeat(secondsAgo(-5), now, STALE_AFTER)).toEqual({
      status: 'ok',
      lastBeatSeconds: 0,
    })
  })

  it('gives a worker four beats of slack before it is stale', () => {
    expect(STALE_AFTER * 1000).toBe(BEAT_EVERY_MS * 4)
  })
})

// This package's own test database (SPA-143), emptied before this file was
// imported (SPA-145) — no afterAll, because the row this writes is gone
// before the next file runs whether or not anyone remembers to delete it.
describe('beat (database)', () => {
  const role = `test-${randomUUID()}`

  it('upserts on the role key, so restarts leave exactly one row', async () => {
    const first = {
      role,
      instance: 'container-a',
      pid: 11,
      bootedAt: secondsAgo(600),
    }
    await beat(first)
    await beat(first)
    await beat({
      role,
      instance: 'container-b',
      pid: 22,
      bootedAt: secondsAgo(5),
    })

    const rows = await db
      .select()
      .from(workerHeartbeat)
      .where(eq(workerHeartbeat.role, role))
    expect(rows).toHaveLength(1)
    const row = rows.at(0)
    expect(row?.instance).toBe('container-b')
    expect(row?.pid).toBe(22)

    const lastBeat = await readLastBeat(role)
    expect(lastBeat).not.toBeNull()
    expect(classifyBeat(lastBeat, new Date(), STALE_AFTER).status).toBe('ok')
  })

  it('reads absent for a role that has never beaten', async () => {
    expect(await readLastBeat(`test-${randomUUID()}`)).toBeNull()
  })
})
