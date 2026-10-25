import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { folderNameOf } from '@spaces/core/documents/bindings'
import { formatSince } from '@spaces/core/format'
import { SettingsGroupHead } from './settings-section'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Label } from '#/components/ui/label'
import { Select } from '#/components/ui/select'
import { recordPath } from '#/lib/record-path'
import type {
  AccountBindings,
  BoundFolderHealth,
  RebindChoice,
  RebindStatus,
} from '#/lib/server-fns'
import { rebindFolder, rebindStatus } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * A storage account page's binding health: the Bound folders ledger (each
 * folder, its record, how it syncs, and the verb that fixes it), the Exports
 * ledger while uploads wait to reach a folder, and the Re-bind window.
 * - Ages are read against the loader's `now`, so server and browser agree.
 * - The window checks the folder on the chosen connection before Re-bind is
 *   offered; Re-bind checks it again on the worker and moves the binding.
 */

const POLL_MS = 1500

const LINK =
  'focus-ring rounded-md text-label text-graphite hover:text-foreground'

const filesOf = (n: number) => `${String(n)} ${n === 1 ? 'file' : 'files'}`

type Tone = 'ok' | 'error' | 'paused'

/** A binding's status lane: the dot's tone and the mono line. */
export function bindingStateOf(
  b: BoundFolderHealth,
  now: string,
): { readonly tone: Tone; readonly text: string } {
  const age =
    b.lastSyncedAt === null
      ? null
      : formatSince(Date.parse(now) - Date.parse(b.lastSyncedAt))
  switch (b.status) {
    case 'active':
      return age === null
        ? { tone: 'ok', text: `re-listing · ${filesOf(b.files)}` }
        : { tone: 'ok', text: `in sync · ${age} · ${filesOf(b.files)}` }
    case 'error':
      return {
        tone: 'error',
        text: [b.error ?? 'the provider gave no reason', age]
          .filter((part) => part !== null)
          .join(' · '),
      }
    case 'paused':
      return {
        tone: 'paused',
        text: `paused · ${b.error ?? 'no connection'}`,
      }
  }
}

const DOT: Record<Tone, string> = {
  ok: 'bg-primary',
  error: 'bg-destructive',
  paused: 'border border-graphite',
}

const INK: Record<Tone, string> = {
  ok: 'text-graphite',
  error: 'text-destructive',
  paused: 'text-graphite',
}

/** The bound record's page, or null when it has none. */
const recordOf = (b: BoundFolderHealth): string | null =>
  recordPath({
    kind: b.targetKind,
    id: b.targetId,
    objectSlug: b.targetObjectSlug,
  })

export function BoundFoldersSection({ view }: { view: AccountBindings }) {
  const [rebinding, setRebinding] = useState<BoundFolderHealth | null>(null)
  return (
    <>
      <div className="flex flex-col">
        <SettingsGroupHead
          title="Bound folders"
          count={String(view.bindings.length)}
        />
        {view.bindings.length === 0 ? (
          <p className="border-b border-rule px-3 py-3 text-label text-graphite">
            No folders linked.
          </p>
        ) : (
          view.bindings.map((b) => (
            <BoundFolderRow
              key={b.id}
              binding={b}
              now={view.now}
              onRebind={() => setRebinding(b)}
            />
          ))
        )}
      </div>
      {view.exports.length > 0 ? (
        <div className="flex flex-col">
          <SettingsGroupHead title="Exports" />
          {view.exports.map((e) => (
            <div
              key={e.targetId}
              className="flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-body text-foreground">
                {filesOf(e.count)} waiting for a{' '}
                {view.choices.at(0)?.label ?? 'storage'} connection
              </span>
              <span className="shrink-0 mono text-micro text-graphite">
                since {e.since.slice(5, 10)} · {e.targetName}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {rebinding !== null ? (
        <RebindWindow
          binding={rebinding}
          choices={view.choices}
          onClose={() => setRebinding(null)}
        />
      ) : null}
    </>
  )
}

function BoundFolderRow({
  binding,
  now,
  onRebind,
}: {
  binding: BoundFolderHealth
  now: string
  onRebind: () => void
}) {
  const state = bindingStateOf(binding, now)
  const name = folderNameOf(binding.folderPath)
  const open = recordOf(binding)
  return (
    <div className="flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2">
      <span
        title={binding.folderPath}
        className="min-w-0 flex-1 truncate text-body text-foreground"
      >
        {name}
      </span>
      <span className="w-36 shrink-0 truncate text-label text-graphite">
        {binding.targetName}
      </span>
      <span className="flex w-72 min-w-0 shrink-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0', DOT[state.tone])}
        />
        <span
          title={state.text}
          className={cn('truncate mono text-micro', INK[state.tone])}
        >
          {state.text}
        </span>
      </span>
      <span className="flex w-20 shrink-0 justify-end">
        {binding.status === 'active' ? (
          open === null ? null : (
            <Link
              to={open}
              search={{ tab: 'files' }}
              aria-label={`Open ${binding.targetName}`}
              className={LINK}
            >
              Open ›
            </Link>
          )
        ) : (
          <button
            type="button"
            onClick={onRebind}
            aria-label={`Re-bind ${name}`}
            className={LINK}
          >
            Re-bind ›
          </button>
        )}
      </span>
    </div>
  )
}

/** One check or re-bind on its way: what was sent, and how it stands. */
type Attempt = {
  readonly connectionId: string
  readonly commit: boolean
  readonly checkId: string | null
  readonly status: RebindStatus
}

/**
 * Re-bind is a window: one picker of the reader's connections for the
 * provider, the folder check under it, and Re-bind once the check passed —
 * Try again after a refusal.
 */
function RebindWindow({
  binding,
  choices,
  onClose,
}: {
  binding: BoundFolderHealth
  choices: ReadonlyArray<RebindChoice>
  onClose: () => void
}) {
  const router = useRouter()
  const usable = choices.filter((c) => c.status === 'active')
  const [connectionId, setConnectionId] = useState(
    usable.at(0)?.connectionId ?? '',
  )
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const chosen = choices.find((c) => c.connectionId === connectionId)

  const send = useCallback(
    async (commit: boolean) => {
      if (connectionId === '') return
      setAttempt({
        connectionId,
        commit,
        checkId: null,
        status: { state: 'checking' },
      })
      const refused = (reason: string) =>
        setAttempt({
          connectionId,
          commit,
          checkId: null,
          status: { state: 'refused', reason },
        })
      try {
        const sent = await rebindFolder({
          data: { bindingId: binding.id, connectionId, commit },
        })
        if (sent._tag === 'refused') refused(sent.reason)
        else
          setAttempt({
            connectionId,
            commit,
            checkId: sent.checkId,
            status: { state: 'checking' },
          })
      } catch (err) {
        refused(err instanceof Error ? err.message : 'Could not check')
      }
    },
    [binding.id, connectionId],
  )

  // Each pick is checked at once: Re-bind is offered only on a pass.
  useEffect(() => {
    void send(false)
  }, [send])

  const checkId = attempt?.checkId ?? null
  const settledOn = attempt?.status.state
  useEffect(() => {
    if (checkId === null || settledOn !== 'checking') return
    let stopped = false
    const timer = setInterval(() => {
      void rebindStatus({ data: { checkIds: [checkId] } }).then(
        (answer) => {
          if (stopped || !Object.hasOwn(answer, checkId)) return
          const now = answer[checkId]
          if (now.state === 'checking') return
          setAttempt((a) =>
            a === null || a.checkId !== checkId ? a : { ...a, status: now },
          )
        },
        () => undefined,
      )
    }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [checkId, settledOn])

  // A passed re-bind closes the window; the row reads re-listing.
  const done =
    attempt !== null && attempt.commit && attempt.status.state === 'passed'
  useEffect(() => {
    if (!done) return
    toast.success(`${folderNameOf(binding.folderPath)} re-bound · re-listing`)
    onClose()
    void router.invalidate()
  }, [done, binding.folderPath, onClose, router])

  const status = attempt?.status ?? { state: 'checking' }
  const refused = status.state === 'refused'
  const passed = status.state === 'passed' && attempt?.commit === false
  const busy = status.state === 'checking'

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-bind</DialogTitle>
          <DialogDescription>{binding.folderPath}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Label htmlFor="rebind-with">With</Label>
            <Select
              id="rebind-with"
              aria-label="Connection"
              width="content"
              value={connectionId}
              onChange={setConnectionId}
              disabled={busy && attempt?.commit === true}
              items={choices.map((c) => ({
                value: c.connectionId,
                label: `${c.email} · ${c.label}`,
                disabled: c.status !== 'active',
              }))}
            />
          </div>
          <p
            className={cn(
              'mono text-micro',
              refused ? 'text-destructive' : 'text-graphite',
            )}
          >
            {usable.length === 0
              ? 'None of your connections can read folders; reconnect one first'
              : status.state === 'checking'
                ? attempt?.commit
                  ? 'Re-binding…'
                  : `Checking the folder on ${chosen?.email ?? 'this connection'}…`
                : status.state === 'refused'
                  ? status.reason
                  : `■ ${status.line}`}
          </p>
        </div>
        <DialogFooter note="re-lists · no duplicates">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {refused ? (
            <Button
              size="sm"
              disabled={usable.length === 0}
              onClick={() => void send(false)}
            >
              Try again
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!passed}
              onClick={() => void send(true)}
            >
              Re-bind
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
