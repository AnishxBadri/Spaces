import { describe, expect, it } from 'vitest'
import {
  emptyJobStatus,
  jobStatusEvent,
} from '#/lib/integrations/job-status-view'
import { enrichPhase, evidenceLabel, foundByLine } from './discovery-view'

const event = (status: 'running' | 'succeeded' | 'failed', queue = 'q') => ({
  jobRunId: `${queue}-1`,
  queue,
  integrationId: null,
  entityId: 'e',
  status,
  startedAt: '2026-10-10T00:00:00.000Z',
  summary: null,
  error: null,
})

describe('a discovery card’s words', () => {
  it('says "found by n watches" only past one', () => {
    expect(foundByLine(0)).toBeNull()
    expect(foundByLine(1)).toBeNull()
    expect(foundByLine(3)).toBe('found by 3 watches')
  })

  it('labels evidence by title, else host', () => {
    expect(evidenceLabel({ url: 'https://x.example/a', title: 'A' })).toBe('A')
    expect(evidenceLabel({ url: 'https://www.x.example/a' })).toBe('x.example')
  })
})

describe('the after-state of an added company', () => {
  it('is enriching while a job runs or none has shown yet, and settles after', () => {
    expect(enrichPhase(emptyJobStatus, false)).toBe('enriching')
    expect(enrichPhase(emptyJobStatus, true)).toBe('added')
    const running = jobStatusEvent(emptyJobStatus, event('running'))
    expect(enrichPhase(running, true)).toBe('enriching')
    expect(
      enrichPhase(jobStatusEvent(running, event('succeeded')), false),
    ).toBe('enriched')
    expect(enrichPhase(jobStatusEvent(running, event('failed')), false)).toBe(
      'enrich-failed',
    )
  })
})
