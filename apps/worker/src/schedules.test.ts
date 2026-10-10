import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { QUEUES } from '@spaces/core/queue/names'
import { CORE_SCHEDULES } from './schedules'

/**
 * No periodic refresh: nothing re-enriches a record on a clock. (D76)
 */

const ENRICHMENT_QUEUES: ReadonlyArray<string> = [
  QUEUES.enrichmentRun,
  QUEUES.enrichEntity,
]

describe('the worker’s schedule list', () => {
  it('schedules the three nightly scans and no enrichment queue', () => {
    expect(CORE_SCHEDULES.map((s) => s.queue)).toEqual([
      QUEUES.dedupeSweep,
      QUEUES.sweepOrphanBlobs,
      QUEUES.pruneIngress,
    ])
    for (const { queue } of CORE_SCHEDULES)
      expect(ENRICHMENT_QUEUES).not.toContain(queue)
  })

  it('the boot calls boss.schedule only over that list', () => {
    const index = readFileSync(
      fileURLToPath(new URL('./index.ts', import.meta.url)),
      'utf8',
    )
    const calls = [...index.matchAll(/boss\.schedule\(\s*([^,]+),/g)].map(
      (m) => m[1],
    )
    expect(calls).toEqual(['queue'])
  })
})
