import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { QUEUES } from '@spaces/core/queue/names'
import { CORE_SCHEDULES, CORE_SCHEDULE_TZ, scheduleCoreJobs } from './schedules'

/**
 * No periodic refresh: nothing re-enriches a record on a clock. (D76)
 */

const ENRICHMENT_QUEUES: ReadonlyArray<string> = [QUEUES.enrichmentRun]

describe('the worker’s schedule list', () => {
  it('schedules the three nightly scans, the stats roll, the storage poll and no enrichment queue', () => {
    expect(CORE_SCHEDULES.map((s) => s.queue)).toEqual([
      QUEUES.dedupeSweep,
      QUEUES.sweepOrphanBlobs,
      QUEUES.pruneIngress,
      QUEUES.rollInteractionStats,
      QUEUES.pollStorageChanges,
    ])
    for (const { queue } of CORE_SCHEDULES)
      expect(ENRICHMENT_QUEUES).not.toContain(queue)
  })

  it('the boot schedules through scheduleCoreJobs, which calls boss.schedule only over that list', () => {
    const read = (file: string) =>
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    const scheduleCalls = (source: string) =>
      [...source.matchAll(/boss\.schedule\(\s*([^,]+),/g)].map((m) => m[1])
    const index = read('./index.ts')
    expect(scheduleCalls(index)).toEqual([])
    expect(index).toMatch(/await scheduleCoreJobs\(boss\)/)
    expect(scheduleCalls(read('./schedules.ts'))).toEqual(['queue'])
  })

  it('polls storage every fifteen minutes, and a second boot leaves one schedule per queue', async () => {
    expect(
      CORE_SCHEDULES.find((s) => s.queue === QUEUES.pollStorageChanges)?.cron,
    ).toBe('*/15 * * * *')
    const connectionString = process.env.DATABASE_URL
    if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
    // The cron clock and maintenance stay off: only the rows are read.
    const boss = new PgBoss({
      connectionString,
      schema: 'pgboss',
      schedule: false,
      supervise: false,
    })
    boss.on('error', (error: Error) => console.error('[pg-boss]', error))
    await boss.start()
    try {
      for (const { queue } of CORE_SCHEDULES)
        await boss.createQueue(queue).catch(() => {})
      // Two boots.
      await scheduleCoreJobs(boss)
      await scheduleCoreJobs(boss)
      const names = CORE_SCHEDULES.map((s) => s.queue)
      const rows = (
        await db.execute<{ name: string; cron: string; timezone: string }>(
          sql`select name, cron, timezone from pgboss.schedule where name in ${names} order by name`,
        )
      ).rows
      expect(rows).toHaveLength(CORE_SCHEDULES.length)
      expect(rows.find((r) => r.name === QUEUES.pollStorageChanges)).toEqual({
        name: QUEUES.pollStorageChanges,
        cron: '*/15 * * * *',
        timezone: CORE_SCHEDULE_TZ,
      })
    } finally {
      await boss.stop({ graceful: false })
    }
  })
})
