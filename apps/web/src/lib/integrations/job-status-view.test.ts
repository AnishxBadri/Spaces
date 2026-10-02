import { describe, expect, it } from 'vitest'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import type { JobStatusRow } from './job-status'
import {
  RECENT_MS,
  decodeInit,
  decodeStatus,
  emptyJobStatus,
  jobStatusEvent,
  jobStatusFigure,
  jobStatusFired,
  jobStatusInit,
} from './job-status-view'

/**
 * The record head's reducer over the status stream (D64): pending the moment
 * an action fires, the outcome when its row closes, state on reopen from
 * `init` alone, and no stale event undoing a newer one.
 */

const QUEUE = 'plugin.apollo.enrichCompany'
const ENTITY = 'f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa'

const event = (
  jobRunId: string,
  status: JobStatusEvent['status'],
  startedAt = '2026-10-03T10:00:00.000Z',
): JobStatusEvent => ({
  jobRunId,
  queue: QUEUE,
  integrationId: null,
  entityId: ENTITY,
  status,
  startedAt,
  summary: status === 'succeeded' ? 'filled 2 fields' : null,
  error: status === 'failed' ? 'permanent: Apollo said 403' : null,
})

const initRow = (
  e: JobStatusEvent,
  closedAgoMs: number | null,
): JobStatusRow => ({
  ...e,
  closedAgoMs,
})

describe('the record head job status', () => {
  it('reads pending the moment an action fires, then running, then the outcome', () => {
    let state = jobStatusInit(emptyJobStatus, [])
    expect(jobStatusFigure(state, QUEUE)).toBeNull()

    state = jobStatusFired(state, QUEUE)
    expect(jobStatusFigure(state, QUEUE)).toMatchObject({
      text: 'running…',
      tone: 'muted',
    })
    state = jobStatusEvent(state, event('a', 'running'))
    expect(state.fired.size).toBe(0)
    expect(jobStatusFigure(state, QUEUE)).toMatchObject({ tone: 'muted' })

    state = jobStatusEvent(state, event('a', 'failed'))
    expect(jobStatusFigure(state, QUEUE)).toEqual({
      text: 'failed',
      tone: 'bad',
      detail: 'permanent: Apollo said 403',
    })
  })

  it('a fired action stays pending through an init that shows only the run it was fired over', () => {
    let state = jobStatusInit(emptyJobStatus, [
      initRow(event('old', 'succeeded'), 1000),
    ])
    state = jobStatusFired(state, QUEUE)
    // A reconnect before the job started: the old run is all job_run has.
    state = jobStatusInit(state, [initRow(event('old', 'succeeded'), 2000)])
    expect(jobStatusFigure(state, QUEUE)?.text).toBe('running…')
    // A reconnect after it ran: a run it was not fired over settles it.
    state = jobStatusInit(state, [
      initRow(event('new', 'succeeded', '2026-10-03T10:05:00.000Z'), 10),
    ])
    expect(state.fired.size).toBe(0)
    expect(jobStatusFigure(state, QUEUE)).toMatchObject({ text: 'done' })
  })

  it('reopening mid-run shows running from init alone', () => {
    const state = jobStatusInit(emptyJobStatus, [
      initRow(event('a', 'running'), null),
    ])
    expect(jobStatusFigure(state, QUEUE)).toMatchObject({
      text: 'running…',
      tone: 'muted',
    })
  })

  it('a run that closed long before the page opened shows nothing', () => {
    const old = jobStatusInit(emptyJobStatus, [
      initRow(event('a', 'failed'), RECENT_MS + 1),
    ])
    expect(jobStatusFigure(old, QUEUE)).toBeNull()
    const recent = jobStatusInit(emptyJobStatus, [
      initRow(event('a', 'failed'), RECENT_MS - 1),
    ])
    expect(jobStatusFigure(recent, QUEUE)?.tone).toBe('bad')
  })

  it('a late running event never reopens a closed run, and an older attempt never replaces a newer one', () => {
    let state = jobStatusEvent(emptyJobStatus, event('a', 'succeeded'))
    state = jobStatusEvent(state, event('a', 'running'))
    expect(jobStatusFigure(state, QUEUE)?.text).toBe('done')

    state = jobStatusEvent(
      state,
      event('b', 'running', '2026-10-03T10:05:00.000Z'),
    )
    state = jobStatusEvent(
      state,
      event('z', 'failed', '2026-10-03T09:00:00.000Z'),
    )
    expect(state.rows.get(QUEUE)?.jobRunId).toBe('b')
  })

  it('decodes the stream frames and refuses anything else', () => {
    const e = event('a', 'running')
    expect(decodeStatus(JSON.stringify(e))).toEqual(e)
    expect(decodeInit(JSON.stringify({ rows: [initRow(e, null)] }))).toEqual([
      initRow(e, null),
    ])
    expect(decodeStatus('{')).toBeNull()
    expect(decodeInit(JSON.stringify({ rows: [{ status: 'odd' }] }))).toBeNull()
  })
})
