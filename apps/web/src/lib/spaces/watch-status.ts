import type { JobStatusEvent } from '@spaces/core/queue/job-status'

/**
 * The Watching lane's rules, pure and client-safe: the cadence choices, a
 * watch's label, and each watch's status off the space's job-status stream,
 * keyed by watch. (D64, D72)
 * - The loader's latest `job_run` per watch seeds the state; the stream's
 *   `init` replaces it and `status` applies on top, an older attempt never
 *   overwriting a newer one.
 * - Run now reads queued at once and stays so until a run it was not
 *   pressed over arrives for that watch.
 */

/** How often: Manual first and the space page's default. (D77) */
export const CADENCES: ReadonlyArray<{
  readonly value: string
  readonly label: string
  readonly minutes: number | null
}> = [
  { value: 'manual', label: 'Manual', minutes: null },
  { value: 'hourly', label: 'Hourly', minutes: 60 },
  { value: 'daily', label: 'Daily', minutes: 1440 },
  { value: 'weekly', label: 'Weekly', minutes: 10080 },
]

/** A cadence as the row prints it: `manual`, `daily`, `every 90m`. */
export function cadenceWord(minutes: number | null): string {
  if (minutes === null) return 'manual'
  const named = CADENCES.find((c) => c.minutes === minutes)
  if (named) return named.label.toLowerCase()
  return minutes % 1440 === 0
    ? `every ${minutes / 1440}d`
    : minutes % 60 === 0
      ? `every ${minutes / 60}h`
      : `every ${minutes}m`
}

/** The setting keys the window draws as "At most · per run". */
const PER_RUN_KEYS: ReadonlySet<string> = new Set([
  'cap',
  'max',
  'limit',
  'atmost',
  'perrun',
  'maxperrun',
  'maxresults',
])

/**
 * A watch job's fields split for the window: the per-run cap (a whole
 * number keyed like `cap`) is At most; every other field is Look for.
 */
export function splitWatchFields<
  T extends { readonly key: string; readonly kind: string },
>(fields: ReadonlyArray<T>): { lookFor: Array<T>; atMost: T | null } {
  const atMost =
    fields.find(
      (f) =>
        f.kind === 'number' &&
        PER_RUN_KEYS.has(f.key.toLowerCase().replace(/[_-]/g, '')),
    ) ?? null
  return { lookFor: fields.filter((f) => f !== atMost), atMost }
}

/** A watch's label: its first text setting, else its engine's name. */
export function watchLabel(
  settings: { readonly [key: string]: unknown },
  engine: string,
): string {
  for (const value of Object.values(settings))
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return engine
}

/** One watch run, as the stream or the loader knows it. */
export type WatchRunState = {
  readonly jobRunId: string
  readonly status: JobStatusEvent['status']
  readonly startedAt: string
  readonly summary: string | null
  readonly error: string | null
}

export type WatchStatusState = {
  readonly runs: ReadonlyMap<string, WatchRunState>
  /** Watches Run now was pressed on, each with the run it was pressed over. */
  readonly fired: ReadonlyMap<string, string | null>
}

const settle = (
  fired: ReadonlyMap<string, string | null>,
  runs: ReadonlyMap<string, WatchRunState>,
): ReadonlyMap<string, string | null> =>
  new Map(
    [...fired].filter(
      ([watch, over]) => (runs.get(watch)?.jobRunId ?? null) === over,
    ),
  )

const runOf = (e: {
  jobRunId: string
  status: JobStatusEvent['status']
  startedAt: string
  summary: string | null
  error: string | null
}): WatchRunState => ({
  jobRunId: e.jobRunId,
  status: e.status,
  startedAt: e.startedAt,
  summary: e.summary,
  error: e.error,
})

/** The state the loader's latest runs open with, before the stream speaks. */
export function watchStatusFrom(
  runs: ReadonlyArray<{ watchId: string; run: WatchRunState | null }>,
): WatchStatusState {
  return {
    runs: new Map(
      runs.flatMap((r) => (r.run === null ? [] : [[r.watchId, runOf(r.run)]])),
    ),
    fired: new Map(),
  }
}

/** The stream's `init`: what `job_run` says now replaces what was known. */
export function watchStatusInit(
  state: WatchStatusState,
  rows: ReadonlyArray<JobStatusEvent>,
): WatchStatusState {
  const runs = new Map(state.runs)
  for (const row of rows)
    if (row.watchId !== undefined && row.watchId !== null)
      runs.set(row.watchId, runOf(row))
  return { runs, fired: settle(state.fired, runs) }
}

/** One live notification; a run with no watch is not this lane's. */
export function watchStatusEvent(
  state: WatchStatusState,
  event: JobStatusEvent,
): WatchStatusState {
  const watchId = event.watchId
  if (watchId === undefined || watchId === null) return state
  const known = state.runs.get(watchId)
  if (known !== undefined) {
    // A close never reopens, and an earlier attempt never replaces a later one.
    if (known.jobRunId === event.jobRunId) {
      if (known.status !== 'running' && event.status === 'running') return state
    } else if (known.startedAt > event.startedAt) return state
  }
  const runs = new Map(state.runs).set(watchId, runOf(event))
  return { runs, fired: settle(state.fired, runs) }
}

export function watchStatusFired(
  state: WatchStatusState,
  watchId: string,
): WatchStatusState {
  return {
    runs: state.runs,
    fired: new Map(state.fired).set(
      watchId,
      state.runs.get(watchId)?.jobRunId ?? null,
    ),
  }
}

export function watchStatusRefused(
  state: WatchStatusState,
  watchId: string,
): WatchStatusState {
  const fired = new Map(state.fired)
  fired.delete(watchId)
  return { runs: state.runs, fired }
}

/** The status cell: its words, its tone, and the detail behind it. */
export type WatchCell = {
  readonly text: string
  readonly tone: 'bad' | 'muted' | undefined
  readonly detail: string | null
}

export function watchCell(
  state: WatchStatusState,
  watchId: string,
): WatchCell | null {
  if (state.fired.has(watchId))
    return { text: 'queued', tone: 'muted', detail: null }
  const run = state.runs.get(watchId)
  if (run === undefined) return null
  switch (run.status) {
    case 'running':
      return { text: 'running', tone: 'muted', detail: null }
    case 'failed':
      return { text: 'failed', tone: 'bad', detail: run.error }
    case 'skipped':
      return { text: 'skipped', tone: 'muted', detail: run.summary }
    case 'succeeded':
      return { text: run.summary ?? 'done', tone: undefined, detail: null }
  }
}

/** When the watch last ran: the live run's start, else the row's stamp. */
export function lastRunOf(
  state: WatchStatusState,
  watchId: string,
  stamped: string | null,
): string | null {
  const live = state.runs.get(watchId)?.startedAt ?? null
  if (live === null) return stamped
  if (stamped === null) return live
  return live > stamped ? live : stamped
}
