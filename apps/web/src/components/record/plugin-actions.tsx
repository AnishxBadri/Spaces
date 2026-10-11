import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useReducer, useState } from 'react'
import type { ActionDispatch } from 'react'
import { toast } from 'sonner'
import { LedgerFigure } from '#/components/ledger-section'
import { NeedsSetup } from '#/components/needs-setup'
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
 * A record head's plugin actions: one outline button per manifest action
 * declared on this record's kind, beside the record's own, each with its
 * job's state in a ledger figure. (D63, D64)
 * - The list comes from the loader, which offers only runnable plugins; a
 *   stopped one is absent here and explained on Today and Review.
 * - Firing reads pending at once; the status stream turns it into the
 *   outcome, and a reopened page or a reconnected stream reads `job_run`.
 *   No polling.
 * - With `enrich`, the host's Enrich comes first and asks every source in
 *   order, so a source's own Enrich action is not drawn beside it. (D76)
 */
export function PluginActions({
  entityId,
  actions,
  enrich,
}: {
  entityId: string
  actions: ReadonlyArray<RecordAction>
  /** The host's Enrich on a company or a person; absent elsewhere. */
  enrich?: RecordEnrichView | undefined
}) {
  const { state: status, dispatch } = useJobStatus(
    entityId,
    actions.length > 0 || enrich !== undefined,
  )
  const shown =
    enrich === undefined
      ? actions
      : actions.filter((a) => !a.actionId.startsWith('enrich'))
  return (
    <>
      {enrich === undefined ? null : (
        <EnrichAction
          entityId={entityId}
          enrich={enrich}
          status={status}
          dispatch={dispatch}
        />
      )}
      {shown.map((action) => (
        <PluginActionButton
          key={`${action.integrationId}:${action.actionId}`}
          entityId={entityId}
          action={action}
          status={status}
          onFired={() => dispatch({ kind: 'fired', queue: action.queue })}
          onRefused={() => dispatch({ kind: 'refused', queue: action.queue })}
        />
      ))}
    </>
  )
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

/** A record's enrichment and who the reader is told to ask for more. */
export type RecordEnrichView = RecordEnrichment & {
  readonly audience: SetupAudience
  readonly kind: 'company' | 'person'
}

const LINE_INK: { readonly [T in LastRun['tone'] | 'idle']: string } = {
  done: 'text-primary',
  muted: 'text-graphite',
  warn: 'text-[var(--badge-amber-ink)]',
  bad: 'text-destructive',
  idle: 'text-graphite',
}

const ENRICH_QUEUE = QUEUES.enrichmentRun

/** The Enrich line's words and ink: running, the last run, or what it will ask. */
export function enrichLine(
  enrich: RecordEnrichment,
  running: boolean,
): { words: string; tone: LastRun['tone'] | 'idle'; square: boolean } {
  if (running)
    return {
      words: `${askWords(enrich.sources)}…`,
      tone: 'muted',
      square: true,
    }
  if (enrich.last !== null)
    return { words: enrich.last.words, tone: enrich.last.tone, square: true }
  if (enrich.sensitive)
    return {
      words: enrich.onlyFree
        ? 'sensitive · Website only'
        : 'sensitive · local sources only',
      tone: 'warn',
      square: true,
    }
  return { words: askWords(enrich.sources), tone: 'idle', square: false }
}

/**
 * The host's Enrich (D76, D80): one button that asks every source in the
 * owner's order, and one mono line beside it — the sources it will ask
 * ("Website, then Apollo"), then while it runs and how it went: done with
 * counts, nothing blank, sensitive (local sources only), a source's limit
 * reached with the reset, or the failure.
 * - With only free sources on, "More sources ›" follows, in place: before
 *   any run an admin reads "Website, then More sources ›".
 * - A company always has the Website, with or without a model. (D80)
 */
function EnrichAction({
  entityId,
  enrich,
  status,
  dispatch,
}: {
  entityId: string
  enrich: RecordEnrichView
  status: JobStatusState
  dispatch: ActionDispatch<[action: Action]>
}) {
  const [firing, setFiring] = useState(false)
  if (enrich.sources.length === 0) return null

  const figure = jobStatusFigure(status, ENRICH_QUEUE)
  const running = figure?.text === 'running…'
  const line = enrichLine(enrich, running)
  const more = enrich.onlyFree && !running
  const thenMore = more && line.tone === 'idle' && enrich.audience.isAdmin

  async function fire() {
    setFiring(true)
    dispatch({ kind: 'fired', queue: ENRICH_QUEUE })
    try {
      const result = await enrichRecord({ data: { entityId } })
      if (!result.queued) {
        dispatch({ kind: 'refused', queue: ENRICH_QUEUE })
        toast.error('The worker queue is unreachable; try again shortly')
      }
    } catch (err) {
      dispatch({ kind: 'refused', queue: ENRICH_QUEUE })
      toast.error(err instanceof Error ? err.message : 'Could not start Enrich')
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
        title={`Enrich from ${askWords(enrich.sources)}`}
      >
        Enrich
      </Button>
      <span
        data-enrich-line={line.tone}
        className={cn(
          'flex max-w-80 items-center gap-1.5 truncate mono text-micro',
          LINE_INK[line.tone],
        )}
      >
        {line.square ? (
          <span aria-hidden className="size-1.5 shrink-0 bg-current" />
        ) : null}
        <span className="truncate">
          {line.words}
          {thenMore ? ', then ' : null}
        </span>
        {thenMore ? (
          <Link
            to="/settings/enrichment"
            className="focus-ring shrink-0 text-primary hover:underline"
          >
            More sources ›
          </Link>
        ) : null}
      </span>
      {enrich.last?.review === true && !running ? (
        <Link
          to="/review"
          className="focus-ring mono text-micro text-primary hover:underline"
        >
          Review ›
        </Link>
      ) : null}
      {more && !thenMore ? (
        <NeedsSetup
          needs="Free sources only"
          action="More sources"
          to="/settings/enrichment"
          thing="more enrichment sources"
          audience={enrich.audience}
        />
      ) : null}
    </span>
  )
}
