import { describe, expect, it } from 'vitest'
import { nextAttemptAt } from './poll'
import { cadenceCron } from './schedule'

/**
 * SPA-56: the two timing rules of the mailbox, pure. `cadenceCron` is what
 * the worker schedules `mail.poll` with (the sync itself is asserted in
 * `worker/jobs/poll-mailbox.test.ts`); `nextAttemptAt` is the backoff a
 * refused login earns instead of a tight retry loop.
 */

describe('cadenceCron', () => {
  it.each([
    [1, '* * * * *'],
    [5, '*/5 * * * *'],
    [30, '*/30 * * * *'],
    [60, '0 * * * *'],
  ])('%i minutes → %s', (minutes, cron) => {
    expect(cadenceCron(minutes)).toBe(cron)
  })
})

describe('nextAttemptAt — the backoff', () => {
  const t0 = new Date('2026-09-27T10:00:00Z')
  it('doubles the cadence per consecutive failure', () => {
    expect(nextAttemptAt(t0, 5, 1).toISOString()).toBe(
      '2026-09-27T10:10:00.000Z',
    )
    expect(nextAttemptAt(t0, 5, 3).toISOString()).toBe(
      '2026-09-27T10:40:00.000Z',
    )
  })
  it('never waits more than six hours', () => {
    expect(nextAttemptAt(t0, 30, 10).toISOString()).toBe(
      '2026-09-27T16:00:00.000Z',
    )
  })
})
