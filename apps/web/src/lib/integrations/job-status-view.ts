import { z } from 'zod'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import type { JobStatusRow } from './job-status'

/**
 * The record head's view of its plugin jobs, from the status stream: pure,
 * so the page and its tests share one reducer. (D64)
 * - `init` replaces everything known; `status` applies one row on top, and
 *   an older row never overwrites a newer one.
 * - A fired action reads pending at once and stays pending until a row it
 *   has not seen arrives for its queue.
 * - A row closed before the page opened shows only if it closed recently.
 */

/** How old a closed row from `init` may be and still show its outcome. */
export const RECENT_MS = 10 * 60 * 1000

const eventSchema = z.object({
  jobRunId: z.string(),
  queue: z.string(),
  integrationId: z.string().nullable(),
  entityId: z.string().nullable(),
  status: z.enum(['running', 'succeeded', 'failed', 'skipped']),
  startedAt: z.string(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
})

const initSchema = z.object({
  rows: z.array(eventSchema.extend({ closedAgoMs: z.number().nullable() })),
})

const parse = (data: string): unknown => {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

/** An `init` event's data, or null for anything else. */
export const decodeInit = (data: string): Array<JobStatusRow> | null => {
  const parsed = initSchema.safeParse(parse(data))
  return parsed.success ? parsed.data.rows : null
}

/** A `status` event's data, or null for anything else. */
export const decodeStatus = (data: string): JobStatusEvent | null => {
  const parsed = eventSchema.safeParse(parse(data))
  return parsed.success ? parsed.data : null
}

type Known = JobStatusEvent & { readonly shown: boolean }

export type JobStatusState = {
  readonly rows: ReadonlyMap<string, Known>
  /** Queues fired from this page, each with the row it was fired over. */
  readonly fired: ReadonlyMap<string, string | null>
}

export const emptyJobStatus: JobStatusState = {
  rows: new Map(),
  fired: new Map(),
}

/** Clears a fired queue once a row it was not fired over is known. */
const settleFired = (
  fired: ReadonlyMap<string, string | null>,
  rows: ReadonlyMap<string, Known>,
): ReadonlyMap<string, string | null> =>
  new Map(
    [...fired].filter(
      ([queue, over]) => (rows.get(queue)?.jobRunId ?? null) === over,
    ),
  )

export const jobStatusFired = (
  state: JobStatusState,
  queue: string,
): JobStatusState => ({
  rows: state.rows,
  fired: new Map(state.fired).set(
    queue,
    state.rows.get(queue)?.jobRunId ?? null,
  ),
})

export const jobStatusInit = (
  state: JobStatusState,
  init: ReadonlyArray<JobStatusRow>,
): JobStatusState => {
  const rows = new Map<string, Known>(
    init.map(({ closedAgoMs, ...row }) => [
      row.queue,
      {
        ...row,
        shown:
          row.status === 'running' ||
          (closedAgoMs !== null && closedAgoMs <= RECENT_MS),
      },
    ]),
  )
  return { rows, fired: settleFired(state.fired, rows) }
}

export const jobStatusEvent = (
  state: JobStatusState,
  event: JobStatusEvent,
): JobStatusState => {
  const known = state.rows.get(event.queue)
  if (known !== undefined) {
    // A close never reopens, and an earlier attempt never replaces a later one.
    if (known.jobRunId === event.jobRunId) {
      if (known.status !== 'running' && event.status === 'running') return state
    } else if (known.startedAt > event.startedAt) return state
  }
  const rows = new Map(state.rows).set(event.queue, { ...event, shown: true })
  return { rows, fired: settleFired(state.fired, rows) }
}

/** What a record head shows beside an action; a ledger figure's text and tone. */
export type JobStatusFigure = {
  readonly text: string
  readonly tone: 'bad' | 'muted' | undefined
  readonly detail: string | null
}

export const jobStatusFigure = (
  state: JobStatusState,
  queue: string,
): JobStatusFigure | null => {
  if (state.fired.has(queue))
    return { text: 'running…', tone: 'muted', detail: 'queued' }
  const row = state.rows.get(queue)
  if (row === undefined || !row.shown) return null
  switch (row.status) {
    case 'running':
      return { text: 'running…', tone: 'muted', detail: null }
    case 'failed':
      return { text: 'failed', tone: 'bad', detail: row.error }
    case 'skipped':
      return { text: 'skipped', tone: 'muted', detail: row.summary }
    case 'succeeded':
      return { text: 'done', tone: undefined, detail: row.summary }
  }
}
