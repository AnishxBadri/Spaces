import { describe, expect, it } from 'vitest'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import {
  CADENCES,
  cadenceWord,
  splitWatchFields,
  watchCell,
  watchLabel,
  watchStatusEvent,
  watchStatusFired,
  watchStatusFrom,
  watchStatusInit,
} from './watch-status'

/** The Watching lane's pure rules: cadences, labels, and the per-watch status. */

const event = (
  over: Partial<JobStatusEvent> & Pick<JobStatusEvent, 'jobRunId'>,
): JobStatusEvent => ({
  queue: 'plugin.exa.watch',
  integrationId: 'i1',
  entityId: 's1',
  watchId: 'w1',
  status: 'running',
  startedAt: '2026-10-10T10:00:00.000Z',
  summary: null,
  error: null,
  ...over,
})

describe('the cadences', () => {
  it('put Manual first, with no clock', () => {
    expect(CADENCES.at(0)).toEqual({
      value: 'manual',
      label: 'Manual',
      minutes: null,
    })
    expect(cadenceWord(null)).toBe('manual')
    expect(cadenceWord(1440)).toBe('daily')
    expect(cadenceWord(90)).toBe('every 90m')
    expect(cadenceWord(2880)).toBe('every 2d')
  })
})

describe('a watch', () => {
  it('is labelled by its first text setting, else its engine', () => {
    expect(watchLabel({ cap: 5, criteria: 'Orbital fabs' }, 'Exa')).toBe(
      'Orbital fabs',
    )
    expect(watchLabel({ cap: 5, criteria: ' ' }, 'Exa')).toBe('Exa')
  })

  it('draws a whole-number cap as At most and the rest as Look for', () => {
    const fields = [
      { key: 'criteria', kind: 'string' },
      { key: 'max_per_run', kind: 'number' },
    ]
    expect(splitWatchFields(fields)).toEqual({
      lookFor: [fields[0]],
      atMost: fields[1],
    })
    expect(splitWatchFields([fields[0]]).atMost).toBe(null)
  })
})

describe('the status cell', () => {
  it('reads queued on Run now until a new run arrives, never reopens a closed one, and ignores runs of no watch', () => {
    let state = watchStatusFrom([{ watchId: 'w1', run: null }])
    expect(watchCell(state, 'w1')).toBe(null)
    state = watchStatusFired(state, 'w1')
    expect(watchCell(state, 'w1')?.text).toBe('queued')
    state = watchStatusEvent(state, event({ jobRunId: 'r1' }))
    expect(watchCell(state, 'w1')?.text).toBe('running')
    state = watchStatusEvent(
      state,
      event({
        jobRunId: 'r1',
        status: 'succeeded',
        summary: '7 found · 6 cards',
      }),
    )
    state = watchStatusEvent(state, event({ jobRunId: 'r1' }))
    expect(watchCell(state, 'w1')?.text).toBe('7 found · 6 cards')
    const before = state
    state = watchStatusEvent(state, {
      ...event({ jobRunId: 'r2', status: 'failed' }),
      watchId: null,
    })
    expect(state).toBe(before)
  })

  it('settles from init: what job_run says now', () => {
    const state = watchStatusInit(watchStatusFrom([]), [
      event({ jobRunId: 'r9', status: 'failed', error: 'Exa said no' }),
    ])
    expect(watchCell(state, 'w1')).toEqual({
      text: 'failed',
      tone: 'bad',
      detail: 'Exa said no',
    })
  })
})
