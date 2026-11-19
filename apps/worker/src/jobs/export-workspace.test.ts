import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeJobData } from '../job-data'
import { QUEUES } from '@spaces/core/queue/names'
import { readExportSummary } from '@spaces/core/export/workspace'
import { storage } from '@spaces/core/writes/storage'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { JobContext } from '../run-job'
import { exportWorkspace, exportWorkspaceData } from './export-workspace'

/**
 * The job around the export: its data is the admin who asked, and its one
 * line leads with the stored zip's digest and size, which the settings row
 * reads back off the settled job. The zip's contents are apps/web's test.
 */

describe('workspace.export', () => {
  it('refuses data with no requester', () => {
    expect(Result.isSuccess(decodeJobData(exportWorkspaceData, {}))).toBe(false)
  })

  it('stores the zip and names it in its summary', async () => {
    const summary = await Effect.runPromise(
      Effect.provideService(
        exportWorkspace.run({ requestedBy: FIXTURE_ACTOR.id }),
        JobContext,
        JobContext.of({
          queue: QUEUES.exportWorkspace,
          jobId: 'test-export',
          attempt: 1,
          isFinalAttempt: true,
        }),
      ),
    )
    if (typeof summary !== 'string') throw new Error('no summary line')
    expect(summary).toMatch(/· 3 objects · 0 records · 0 notes · 0 documents$/)
    const stored = readExportSummary(summary)
    if (stored === null) throw new Error('the summary names no zip')
    expect((await storage().getBytes(stored.sha)).byteLength).toBe(
      stored.sizeBytes,
    )
  })
})
