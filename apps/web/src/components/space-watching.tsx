import { Link, useRouter } from '@tanstack/react-router'
import { Play } from 'lucide-react'
import { useEffect, useReducer, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { PluginMark } from './integrations/integration-ledger'
import {
  SettingControl,
  settingInputId,
} from './integrations/integration-settings'
import { SectionHead } from './ledger-section'
import { Button } from './ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Select } from './ui/select'
import { addSpaceWatch, runWatchNow } from '#/lib/server-fns'
import type {
  FormValue,
  FormValues,
  SpaceSignal,
  SpaceWatching,
  WatchEngine,
  WatchRow,
} from '#/lib/server-fns'
import { checkSettings, formValuesOf } from '#/lib/integrations/settings-form'
import { decodeInit, decodeStatus } from '#/lib/integrations/job-status-view'
import {
  CADENCES,
  cadenceWord,
  lastRunOf,
  splitWatchFields,
  watchCell,
  watchStatusEvent,
  watchStatusFired,
  watchStatusFrom,
  watchStatusInit,
  watchStatusRefused,
} from '#/lib/spaces/watch-status'
import type { WatchStatusState } from '#/lib/spaces/watch-status'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import { recordPath } from '#/lib/record-path'
import { cn } from '#/lib/utils'

/**
 * The watching half of the space page's details column (D72): Watching —
 * one 32px row per watch with its live status off the space's job-status
 * stream (D64) — and What's moving, the signals on its members. The Add
 * watch window is the head's.
 */

type Action =
  | { kind: 'init'; rows: ReadonlyArray<JobStatusEvent> }
  | { kind: 'status'; event: JobStatusEvent }
  | { kind: 'fired'; watchId: string }
  | { kind: 'refused'; watchId: string }

const reduce = (state: WatchStatusState, action: Action): WatchStatusState => {
  switch (action.kind) {
    case 'init':
      return watchStatusInit(state, action.rows)
    case 'status':
      return watchStatusEvent(state, action.event)
    case 'fired':
      return watchStatusFired(state, action.watchId)
    case 'refused':
      return watchStatusRefused(state, action.watchId)
  }
}

/** How long a refused stream waits before it opens again, at most. */
const REOPEN_MAX_MS = 60_000

/**
 * The space's status stream, keyed by watch. A reopened page settles from
 * `job_run` (the loader's runs, then the stream's `init`), never from a
 * notification it missed.
 */
function useWatchStatus(spaceId: string, watches: ReadonlyArray<WatchRow>) {
  const router = useRouter()
  const [state, dispatch] = useReducer(reduce, watches, (rows) =>
    watchStatusFrom(rows.map((w) => ({ watchId: w.id, run: w.run }))),
  )
  const live = watches.length > 0
  useEffect(() => {
    if (!live || typeof EventSource === 'undefined') return
    let source: EventSource | null = null
    let reopen: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let stopped = false
    const open = () => {
      const es = new EventSource(
        `/api/job-status/${encodeURIComponent(spaceId)}`,
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
        // A settled run may have written signals and stamped the row.
        if (event.status !== 'running' && event.watchId)
          void router.invalidate()
      })
      es.addEventListener('error', () => {
        if (stopped || es.readyState !== EventSource.CLOSED) return
        failures += 1
        reopen = setTimeout(
          open,
          Math.min(REOPEN_MAX_MS, 2000 * 2 ** (failures - 1)),
        )
      })
    }
    open()
    return () => {
      stopped = true
      if (reopen !== null) clearTimeout(reopen)
      source?.close()
    }
  }, [spaceId, live, router])
  return { state, dispatch }
}

/** `10-09`, or a dash before the first run. */
const dayOf = (iso: string | null) => (iso === null ? '—' : iso.slice(5, 10))

export function WatchingLane({
  spaceId,
  watching,
}: {
  spaceId: string
  watching: Pick<SpaceWatching, 'watches' | 'installed'>
}) {
  const { state, dispatch } = useWatchStatus(spaceId, watching.watches)

  async function runNow(watch: WatchRow) {
    dispatch({ kind: 'fired', watchId: watch.id })
    try {
      const sent = await runWatchNow({ data: { watchId: watch.id } })
      if (sent.status === 'not-sent')
        toast(`A run of ${watch.label} is already waiting`)
    } catch (err) {
      dispatch({ kind: 'refused', watchId: watch.id })
      toast.error(err instanceof Error ? err.message : 'Could not run')
    }
  }

  return (
    <section aria-label="Watching" className="flex flex-col">
      {/* Criteria's rule above opens this section. */}
      <SectionHead
        title="Watching"
        count={String(watching.watches.length)}
        className="border-t-0"
      />
      {watching.watches.length === 0 ? (
        <ul aria-label="Engines that can watch" data-empty-lane>
          {watching.installed.map((name) => (
            <LaneRow key={name}>
              <PluginMark name={name} offered />
              <span className="min-w-0 flex-1 truncate text-graphite">
                {name}
              </span>
            </LaneRow>
          ))}
        </ul>
      ) : (
        <ul>
          {watching.watches.map((w) => (
            <WatchLine
              key={w.id}
              watch={w}
              state={state}
              onRun={() => void runNow(w)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** A lane row: 32px on a rule, the details column's grammar. */
function LaneRow({
  children,
  className,
  ...rest
}: {
  children: ReactNode
  className?: string
  'data-watch'?: string
}) {
  return (
    <li
      className={cn(
        'flex h-8 items-center gap-2 border-b border-rule px-3 text-ui',
        className,
      )}
      {...rest}
    >
      {children}
    </li>
  )
}

function WatchLine({
  watch,
  state,
  onRun,
}: {
  watch: WatchRow
  state: WatchStatusState
  onRun: () => void
}) {
  const cell = watchCell(state, watch.id)
  const lastRun = lastRunOf(state, watch.id, watch.lastRunAt)
  const meta = [cadenceWord(watch.cadenceMinutes), dayOf(lastRun)].join(' · ')
  return (
    <LaneRow data-watch={watch.id}>
      <span
        className={cn('flex shrink-0', watch.stopped !== null && 'opacity-40')}
        title={watch.engine}
      >
        <PluginMark name={watch.engine} />
      </span>
      <span
        className="min-w-8 flex-1 truncate"
        title={`${watch.label} · via ${watch.engine}`}
      >
        {watch.label}
      </span>
      {watch.stopped !== null ? (
        <span
          data-stopped
          className="min-w-0 shrink truncate mono text-micro text-destructive"
          title={watch.stopped}
        >
          {watch.stopped}
        </span>
      ) : (
        <>
          <span
            className="shrink-0 mono text-micro text-graphite"
            title={lastRun === null ? 'never run' : `last run ${lastRun}`}
          >
            {meta}
          </span>
          {cell !== null ? (
            <span
              data-cell
              role="status"
              className={cn(
                'min-w-0 shrink truncate mono text-micro',
                cell.tone === 'bad'
                  ? 'text-destructive'
                  : cell.tone === 'muted'
                    ? 'text-graphite'
                    : 'text-foreground',
              )}
              title={cell.detail ?? cell.text}
            >
              {cell.text}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Run now: ${watch.label}`}
            title="Run now"
            disabled={state.fired.has(watch.id)}
            onClick={onRun}
            className="shrink-0"
          >
            <Play strokeWidth={2} />
          </Button>
        </>
      )}
    </LaneRow>
  )
}

/** What's moving folds here, behind "+n more". */
export const MOVING_FOLD = 3

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function WhatsMovingLane({
  signals,
}: {
  signals: ReadonlyArray<SpaceSignal>
}) {
  const [open, setOpen] = useState(false)
  const shown = open ? signals : signals.slice(0, MOVING_FOLD)
  const more = signals.length - shown.length
  return (
    <section aria-label="What's moving" className="flex flex-col">
      <SectionHead title="What's moving" count={String(signals.length)} />
      <ul>
        {shown.map((s) => {
          const href = recordPath({ kind: s.recordKind, id: s.recordId })
          return (
            <li
              key={s.id}
              data-signal={s.id}
              className="flex min-h-8 flex-col justify-center border-b border-rule px-3 py-1.5"
            >
              <div className="flex items-baseline gap-2">
                {href ? (
                  <Link
                    to={href}
                    className="focus-ring min-w-0 flex-1 truncate text-ui font-medium hover:underline"
                  >
                    {s.recordName}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-ui font-medium">
                    {s.recordName}
                  </span>
                )}
                <span className="shrink-0 mono text-micro text-graphite">
                  {s.observedAt.slice(5, 10)}
                </span>
              </div>
              <p className="flex min-w-0 items-baseline gap-1.5 text-label text-graphite">
                <span className="min-w-0 truncate">
                  {s.title ?? s.kind ?? 'signal'}
                </span>
                {s.via !== null ? (
                  <span className="shrink-0">
                    via{' '}
                    <Link
                      to="/spaces/$spaceId"
                      params={{ spaceId: s.via.id }}
                      className="focus-ring hover:text-foreground hover:underline"
                    >
                      {s.via.name}
                    </Link>
                  </span>
                ) : null}
                <span className="shrink-0 mono text-micro">{s.source}</span>
                {s.url !== null ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    data-ref
                    className="focus-ring shrink-0 mono text-micro hover:text-foreground hover:underline"
                  >
                    {hostOf(s.url)} ↗
                  </a>
                ) : s.refs.length > 0 ? (
                  <span data-ref className="shrink-0 mono text-micro">
                    {s.refs.length} ref{s.refs.length === 1 ? '' : 's'}
                  </span>
                ) : null}
              </p>
            </li>
          )
        })}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring flex h-8 items-center border-b border-rule px-3 text-left mono text-micro text-graphite hover:text-foreground"
        >
          +{more} more
        </button>
      ) : null}
    </section>
  )
}

/** One labelled row of the Add watch window. */
function WindowRow({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  error?: string | null
  hint?: string | null
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex min-h-11 items-center gap-4 border-b border-rule py-1.5',
        error && 'bg-[var(--badge-rose)]',
      )}
    >
      <div className="flex w-28 shrink-0 flex-col">
        <label htmlFor={htmlFor} className="text-label text-graphite">
          {label}
        </label>
        {error ? (
          <span role="alert" className="mono text-micro text-destructive">
            {error}
          </span>
        ) : hint ? (
          <span className="mono text-micro text-graphite">{hint}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  )
}

const valuesFor = (engine: WatchEngine | undefined): FormValues =>
  engine !== undefined && engine.form.ok
    ? formValuesOf(engine.form.fields, {})
    : {}

/**
 * Add watch — a window: Engine, Look for (the engine's watch settings),
 * How often (Manual first and the default, D77), At most per run, then
 * Save watch. A text setting equal to the space's criteria saves blank.
 */
export function AddWatchDialog({
  open,
  onOpenChange,
  spaceId,
  spaceName,
  engines,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
  spaceName: string
  engines: ReadonlyArray<WatchEngine>
}) {
  const router = useRouter()
  const [engineId, setEngineId] = useState(engines.at(0)?.integrationId ?? '')
  const engine = engines.find((e) => e.integrationId === engineId)
  const [values, setValues] = useState<FormValues>(() => valuesFor(engine))
  const [cadence, setCadence] = useState('manual')
  const [errors, setErrors] = useState<{ readonly [key: string]: string }>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const first = engines.at(0)
    setEngineId(first?.integrationId ?? '')
    setValues(valuesFor(first))
    setCadence('manual')
    setErrors({})
  }, [open, engines])

  function pickEngine(id: string) {
    setEngineId(id)
    setValues(valuesFor(engines.find((e) => e.integrationId === id)))
    setErrors({})
  }

  const fields = engine?.form.ok === true ? engine.form.fields : []
  const { lookFor, atMost } = splitWatchFields(fields)

  async function save() {
    if (engine === undefined || !engine.form.ok || busy) return
    const checked = checkSettings(engine.form.fields, values)
    if (!checked.ok) {
      setErrors(checked.errors)
      return
    }
    setBusy(true)
    try {
      await addSpaceWatch({
        data: {
          spaceId,
          integrationId: engine.integrationId,
          values,
          cadenceMinutes:
            CADENCES.find((c) => c.value === cadence)?.minutes ?? null,
        },
      })
      onOpenChange(false)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const control = (f: (typeof fields)[number]) => (
    <SettingControl
      field={f}
      value={Object.hasOwn(values, f.key) ? values[f.key] : undefined}
      invalid={Object.hasOwn(errors, f.key)}
      disabled={busy}
      onChange={(v: FormValue) =>
        setValues((prev) => ({ ...prev, [f.key]: v }))
      }
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[32.5rem]"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void save()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Add watch</DialogTitle>
          <span className="mono text-micro text-graphite">{spaceName}</span>
        </DialogHeader>
        <div className="flex flex-col border-t border-rule">
          <WindowRow label="Engine" htmlFor="watch-engine">
            <Select
              id="watch-engine"
              aria-label="Engine"
              width="trigger"
              value={engineId}
              items={engines.map((e) => ({
                value: e.integrationId,
                label: e.name,
              }))}
              onChange={pickEngine}
            />
          </WindowRow>
          {engine !== undefined && !engine.form.ok ? (
            <p
              role="alert"
              className="border-b border-rule py-2 mono text-micro text-destructive"
            >
              {engine.form.reason}
            </p>
          ) : null}
          {lookFor.map((f, i) => (
            <WindowRow
              key={f.key}
              label={i === 0 ? 'Look for' : f.label}
              htmlFor={settingInputId(f.key)}
              error={Object.hasOwn(errors, f.key) ? errors[f.key] : null}
              hint={i === 0 && lookFor.length > 1 ? f.label : null}
            >
              {control(f)}
            </WindowRow>
          ))}
          <WindowRow label="How often" htmlFor="watch-cadence">
            <Select
              id="watch-cadence"
              aria-label="How often"
              width="trigger"
              value={cadence}
              items={CADENCES.map((c) => ({ value: c.value, label: c.label }))}
              onChange={setCadence}
              className="w-40"
            />
          </WindowRow>
          {atMost !== null ? (
            <WindowRow
              label="At most"
              htmlFor={settingInputId(atMost.key)}
              error={
                Object.hasOwn(errors, atMost.key) ? errors[atMost.key] : null
              }
            >
              {control(atMost)}
              <span className="mono text-micro text-graphite">per run</span>
            </WindowRow>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Keep</Button>
          </DialogClose>
          <Button
            disabled={engine === undefined || busy}
            onClick={() => void save()}
          >
            Save watch
            <kbd className="mono text-micro opacity-85">⌘↵</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
