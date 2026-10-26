import { useRouter } from '@tanstack/react-router'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { ActionDispatch } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { MENU_RULE } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import {
  decodeInit,
  decodeStatus,
  emptyJobStatus,
  jobStatusEvent,
  jobStatusFigure,
  jobStatusFired,
  jobStatusInit,
} from '#/lib/integrations/job-status-view'
import type {
  JobStatusState,
  JobToast,
} from '#/lib/integrations/job-status-view'
import { enrichRecord, fireRecordAction } from '#/lib/server-fns'
import type {
  LastRun,
  RecordAction,
  RecordEnrichment,
  SetupAudience,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { askWords } from '@spaces/core/enrichment/link'
import { QUEUES } from '@spaces/core/queue/names'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import type { JobStatusRow } from '#/lib/integrations/job-status'

/**
 * A record's jobs: the host's Enrich, a head verb, and the plugins' manifest
 * actions, which live in the head's `···` under their plugin's name.
 * - The actions come from the loader, which offers only runnable plugins; a
 *   stopped one is absent here and explained on Today and Review.
 * - Firing reads pending at once; the status stream turns it into the
 *   outcome, a toast, and a reopened page or a reconnected stream reads
 *   `job_run`. No polling.
 * - With the host's Enrich on the page, a source's own Enrich action is not
 *   offered beside it: the host asks every source in order.
 */

type Action =
  | { kind: 'fired'; queue: string }
  | { kind: 'refused'; queue: string }
  | { kind: 'init'; rows: ReadonlyArray<JobStatusRow> }
  | { kind: 'status'; event: JobStatusEvent }

const reduce = (state: JobStatusState, action: Action): JobStatusState => {
  switch (action.kind) {
    case 'fired':
      return jobStatusFired(state, action.queue)
    case 'refused': {
      const fired = new Map(state.fired)
      fired.delete(action.queue)
      return { rows: state.rows, fired }
    }
    case 'init':
      return jobStatusInit(state, action.rows)
    case 'status':
      return jobStatusEvent(state, action.event)
  }
}

/** How long a refused stream waits before it opens again, at most. */
const REOPEN_MAX_MS = 60_000

export type RecordJobs = {
  readonly state: JobStatusState
  readonly dispatch: ActionDispatch<[action: Action]>
}

/**
 * The record's status stream. `EventSource` reconnects a dropped stream by
 * itself and the server resyncs it with `init`; one the server refused is
 * closed, and is reopened here with backoff.
 * - `onClosed` hears each job that closes while the page is open, never one
 *   `init` replays: that is when a toast is news.
 */
export function useRecordJobs(
  entityId: string,
  enabled: boolean,
  onClosed: (event: JobStatusEvent) => void,
): RecordJobs {
  const router = useRouter()
  const [state, dispatch] = useReducer(reduce, emptyJobStatus)
  const closed = useRef(onClosed)
  useEffect(() => {
    closed.current = onClosed
  })

  useEffect(() => {
    if (!enabled) return
    let source: EventSource | null = null
    let reopen: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let stopped = false
    const openStream = () => {
      const es = new EventSource(
        `/api/job-status/${encodeURIComponent(entityId)}`,
      )
      source = es
      es.addEventListener('init', (message) => {
        failures = 0
        const rows = decodeInit(message.data)
        if (rows !== null) dispatch({ kind: 'init', rows })
      })
      es.addEventListener('status', (message) => {
        const event = decodeStatus(message.data)
        if (event === null) return
        dispatch({ kind: 'status', event })
        if (event.status === 'running') return
        // The job wrote to the record: show what it wrote.
        void router.invalidate()
        closed.current(event)
      })
      es.addEventListener('error', () => {
        if (stopped || es.readyState !== EventSource.CLOSED) return
        failures += 1
        reopen = setTimeout(
          openStream,
          Math.min(REOPEN_MAX_MS, 2000 * 2 ** (failures - 1)),
        )
      })
    }
    openStream()
    return () => {
      stopped = true
      if (reopen !== null) clearTimeout(reopen)
      source?.close()
    }
  }, [entityId, enabled, router])

  return { state, dispatch }
}

/** The ink toast a closed job leaves, with `Review` when it left a card. */
export function showJobToast(t: JobToast, review: () => void) {
  if (t.tone === 'bad') {
    toast.error(t.message)
    return
  }
  toast(
    t.message,
    t.review ? { action: { label: 'Review', onClick: review } } : {},
  )
}

/** The plugin actions this head offers: a host Enrich takes a source's own. */
export function offeredActions(
  actions: ReadonlyArray<RecordAction>,
  hostEnrich: boolean,
): ReadonlyArray<RecordAction> {
  return hostEnrich
    ? actions.filter((a) => !a.actionId.startsWith('enrich'))
    : actions
}

/**
 * The `···` entries for a record's plugin actions: a rule, then per plugin
 * its name in mono caps over its actions. An action whose job is running
 * says so in its end lane.
 */
export function usePluginEntries(
  entityId: string,
  actions: ReadonlyArray<RecordAction>,
  jobs: RecordJobs,
): Array<MoreMenuEntry> {
  async function fire(action: RecordAction) {
    jobs.dispatch({ kind: 'fired', queue: action.queue })
    try {
      const result = await fireRecordAction({
        data: {
          integrationId: action.integrationId,
          actionId: action.actionId,
          entityId,
        },
      })
      if (result.status !== 'queued') {
        jobs.dispatch({ kind: 'refused', queue: action.queue })
        toast.error('The worker queue is unreachable; try again shortly')
      }
    } catch (err) {
      jobs.dispatch({ kind: 'refused', queue: action.queue })
      toast.error(
        err instanceof Error ? err.message : `Could not start ${action.label}`,
      )
    }
  }

  const entries: Array<MoreMenuEntry> = []
  let plugin: string | null = null
  for (const action of actions) {
    if (action.integrationId !== plugin) {
      plugin = action.integrationId
      entries.push(MENU_RULE, { group: action.pluginName })
    }
    const running =
      jobStatusFigure(jobs.state, action.queue)?.text === 'running…'
    entries.push({
      label: action.label,
      title: `${action.label} with ${action.pluginName}`,
      hint: running ? 'running…' : undefined,
      onSelect: () => void fire(action),
    })
  }
  return entries
}

/** A record's enrichment and who the reader is told to ask for more. */
export type RecordEnrichView = RecordEnrichment & {
  readonly audience: SetupAudience
  readonly kind: 'company' | 'person'
}

export const ENRICH_QUEUE = QUEUES.enrichmentRun

/** What Enrich's tooltip says it will do. */
export function enrichTitle(enrich: RecordEnrichment): string {
  const asks = `Enrich from ${askWords(enrich.sources)}`
  if (!enrich.sensitive) return asks
  return enrich.onlyFree
    ? `${asks} · sensitive: Website only`
    : `${asks} · sensitive: local sources only`
}

/** The toast a finished Enrich leaves: how the run went, as its line says it. */
export function enrichToast(last: LastRun): JobToast {
  return {
    message: `Enrich · ${last.words}`,
    tone: last.tone === 'bad' ? 'bad' : 'done',
    review: last.review,
  }
}

/**
 * The host's Enrich: one outline verb that asks every source in the
 * owner's order. While a run is in flight it reads `Enriching…` in graphite;
 * how it went arrives as a toast, and a parked run is the notices band's.
 */
export function EnrichVerb({
  entityId,
  enrich,
  jobs,
}: {
  entityId: string
  enrich: RecordEnrichView
  jobs: RecordJobs
}) {
  const [firing, setFiring] = useState(false)
  if (enrich.sources.length === 0) return null

  const running = jobStatusFigure(jobs.state, ENRICH_QUEUE)?.text === 'running…'

  async function fire() {
    setFiring(true)
    jobs.dispatch({ kind: 'fired', queue: ENRICH_QUEUE })
    try {
      const result = await enrichRecord({ data: { entityId } })
      if (!result.queued) {
        jobs.dispatch({ kind: 'refused', queue: ENRICH_QUEUE })
        toast.error('The worker queue is unreachable; try again shortly')
      }
    } catch (err) {
      jobs.dispatch({ kind: 'refused', queue: ENRICH_QUEUE })
      toast.error(err instanceof Error ? err.message : 'Could not start Enrich')
    } finally {
      setFiring(false)
    }
  }

  return (
    <Button
      variant="outline"
      data-enrich={running ? 'running' : 'idle'}
      disabled={running}
      pending={firing}
      onClick={() => void fire()}
      title={enrichTitle(enrich)}
      className={cn(running && 'text-graphite disabled:opacity-100')}
    >
      {running ? 'Enriching…' : 'Enrich'}
    </Button>
  )
}
