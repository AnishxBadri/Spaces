import { describe, expect, it } from 'vitest'
import { announcesJobStatus } from './job-status'
import { QUEUES } from './names'

/** Which `job_run` rows reach the record head's status stream. */
describe('announcesJobStatus', () => {
  it('announces every plugin queue and the host’s enrichment run, no other core queue', () => {
    expect(announcesJobStatus('plugin.apollo.enrichCompany')).toBe(true)
    expect(announcesJobStatus(QUEUES.enrichmentRun)).toBe(true)
    expect(announcesJobStatus(QUEUES.importCommit)).toBe(false)
  })
})
