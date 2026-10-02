import { useRouter } from '@tanstack/react-router'
import { useEffect, useReducer, useState } from 'react'
import { toast } from 'sonner'
import { LedgerFigure } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import {
  decodeInit,
  decodeStatus,
  emptyJobStatus,
  jobStatusEvent,
  jobStatusFigure,
  jobStatusFired,
  jobStatusInit,
} from '#/lib/integrations/job-status-view'
import type { JobStatusState } from '#/lib/integrations/job-status-view'
import { fireRecordAction } from '#/lib/server-fns'
import type { RecordAction } from '#/lib/server-fns'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import type { JobStatusRow } from '#/lib/integrations/job-status'

/**
 * A record head's plugin actions: one outline button per manifest action
 * declared on this record's kind, beside the record's own, each with its
 * job's state in a ledger figure. (D63, D64)
 * - The list comes from the loader, which offers only runnable plugins; a
 *   stopped one is absent here and explained on Today and Review.
 * - Firing reads pending at once; the status stream turns it into the
 *   outcome, and a reopened page or a reconnected stream reads `job_run`.
 *   No polling.
 */
export function PluginActions({
  entityId,
  actions,
}: {
  entityId: string
  actions: ReadonlyArray<RecordAction>
}) {
  const { state: status, dispatch } = useJobStatus(entityId, actions.length > 0)
  return actions.map((action) => (
    <PluginActionButton
      key={`${action.integrationId}:${action.actionId}`}
      entityId={entityId}
      action={action}
      status={status}
      onFired={() => dispatch({ kind: 'fired', queue: action.queue })}
      onRefused={() => dispatch({ kind: 'refused', queue: action.queue })}
    />
  ))
}

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

/**
 * The record's status stream. `EventSource` reconnects a dropped stream by
 * itself and the server resyncs it with `init`; one the server refused is
 * closed, and is reopened here with backoff.
 */
function useJobStatus(entityId: string, enabled: boolean) {
  const router = useRouter()
  const [state, dispatch] = useReducer(reduce, emptyJobStatus)

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
        // The job wrote to the record: show what it wrote.
        if (event.status !== 'running') void router.invalidate()
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

function PluginActionButton({
  entityId,
  action,
  status,
  onFired,
  onRefused,
}: {
  entityId: string
  action: RecordAction
  status: JobStatusState
  onFired: () => void
  onRefused: () => void
}) {
  const [firing, setFiring] = useState(false)
  const figure = jobStatusFigure(status, action.queue)

  async function fire() {
    setFiring(true)
    onFired()
    try {
      const result = await fireRecordAction({
        data: {
          integrationId: action.integrationId,
          actionId: action.actionId,
          entityId,
        },
      })
      if (result.status !== 'queued') {
        onRefused()
        toast.error('The worker queue is unreachable; try again shortly')
      }
    } catch (err) {
      onRefused()
      toast.error(
        err instanceof Error ? err.message : `Could not start ${action.label}`,
      )
    } finally {
      setFiring(false)
    }
  }

  return (
    <span className="flex items-center gap-2">
      <Button
        variant="outline"
        pending={firing}
        onClick={() => void fire()}
        title={`${action.label} with ${action.pluginName}`}
      >
        {action.label}
      </Button>
      {figure === null ? null : (
        <span
          title={
            figure.detail === null
              ? action.pluginName
              : `${action.pluginName} · ${figure.detail}`
          }
        >
          <LedgerFigure tone={figure.tone}>{figure.text}</LedgerFigure>
        </span>
      )}
    </span>
  )
}
