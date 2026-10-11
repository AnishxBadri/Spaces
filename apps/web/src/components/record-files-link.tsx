import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { FileGlyph } from './files/file-glyph'
import {
  attachFromLink,
  attachFromPicker,
  linkFetchStatus,
} from '#/lib/server-fns'
import type { PickedFile } from '#/lib/server-fns'
import { isFolderLink, storageLinkProvider } from '#/lib/documents/storage-link'
import { cn } from '#/lib/utils'

/**
 * Attach from a link on the Files tab: the add row, and the `JUST ADDED`
 * rows a pasted Drive link or a picked file shows while the worker fetches.
 * - A fetch reads `fetching.` until the job settles; then the filed row,
 *   in its kind, replaces it.
 * - A refusal stays on its row with the reason; no connection offers
 *   Connect Drive there; a folder link is refused in place, before any
 *   fetch. Each is dismissed by hand. (D66)
 */

export type LinkFetch = {
  readonly key: string
  /** The row's name: the link without its scheme, or the picked file's name. */
  readonly name: string
  readonly label: string
  /** A pasted link, printed mono; false for a file picked by name. */
  readonly link: boolean
  readonly state:
    | { readonly kind: 'sending' }
    | { readonly kind: 'folder'; readonly url: string }
    | { readonly kind: 'fetching'; readonly fetchId: string }
    | {
        readonly kind: 'connect'
        readonly href: string
        readonly action: string
      }
    | { readonly kind: 'refused'; readonly reason: string }
}

const POLL_MS = 2000

const QUEUE_REFUSED = 'The worker queue is unreachable; try again'

/** The link without its scheme, for a row's name. */
const shown = (url: string) => url.replace(/^https?:\/\//, '')

/** Pasted links and picked files on one record, polled while any is fetching. */
export function useLinkFetches(entityId: string) {
  const router = useRouter()
  const [fetches, setFetches] = useState<Array<LinkFetch>>([])

  const update = (key: string, state: LinkFetch['state']) =>
    setFetches((all) => all.map((f) => (f.key === key ? { ...f, state } : f)))

  async function attach(url: string) {
    const provider = storageLinkProvider(url)
    const key = `${url}-${Math.random()}`
    const folder = isFolderLink(url)
    setFetches((all) => [
      ...all,
      {
        key,
        name: shown(url),
        label: provider?.label ?? 'the link',
        link: true,
        state: folder ? { kind: 'folder', url } : { kind: 'sending' },
      },
    ])
    if (folder) return
    try {
      const outcome = await attachFromLink({
        data: { url, attachTo: entityId, returnTo: window.location.pathname },
      })
      if (outcome._tag === 'queued')
        update(key, { kind: 'fetching', fetchId: outcome.fetchId })
      else if (outcome._tag === 'connect')
        update(key, {
          kind: 'connect',
          href: outcome.href,
          action: outcome.label,
        })
      else update(key, { kind: 'refused', reason: outcome.reason })
    } catch (err) {
      update(key, {
        kind: 'refused',
        reason:
          err instanceof Error ? err.message : 'Could not attach this link',
      })
    }
  }

  /** Files picked in the provider's picker: one pending row each, one fetch each. */
  async function attachPicked(picked: ReadonlyArray<PickedFile>) {
    const files = [
      ...new Map(picked.map((f): [string, PickedFile] => [f.id, f])).values(),
    ]
    if (files.length === 0) return
    const batch = Math.random()
    const keyOf = (id: string) => `picked-${id}-${batch}`
    setFetches((all) => [
      ...all,
      ...files.map((f): LinkFetch => ({
        key: keyOf(f.id),
        name: f.name,
        label: 'Drive',
        link: false,
        state: { kind: 'sending' },
      })),
    ])
    const settle = (state: LinkFetch['state']) => {
      for (const f of files) update(keyOf(f.id), state)
    }
    try {
      const outcome = await attachFromPicker({
        data: {
          provider: 'google',
          attachTo: entityId,
          files,
          returnTo: window.location.pathname,
        },
      })
      if (outcome._tag === 'connect')
        settle({ kind: 'connect', href: outcome.href, action: outcome.label })
      else if (outcome._tag === 'refused')
        settle({ kind: 'refused', reason: outcome.reason })
      else
        for (const f of outcome.files)
          update(
            keyOf(f.id),
            f.fetchId === null
              ? { kind: 'refused', reason: QUEUE_REFUSED }
              : { kind: 'fetching', fetchId: f.fetchId },
          )
    } catch (err) {
      settle({
        kind: 'refused',
        reason:
          err instanceof Error ? err.message : 'Could not attach these files',
      })
    }
  }

  const dismiss = (key: string) =>
    setFetches((all) => all.filter((f) => f.key !== key))

  const fetchIds = fetches.flatMap((f) =>
    f.state.kind === 'fetching' ? [f.state.fetchId] : [],
  )
  const polling = fetchIds.join(',')
  const latest = useRef(fetchIds)
  latest.current = fetchIds

  useEffect(() => {
    if (polling === '') return
    let stopped = false
    const timer = setInterval(() => {
      void linkFetchStatus({ data: { fetchIds: latest.current } }).then(
        (status) => {
          if (stopped) return
          setFetches((all) =>
            all.flatMap((f) => {
              if (f.state.kind !== 'fetching') return [f]
              const id = f.state.fetchId
              // A link pasted after this poll left has no answer in it yet.
              if (!Object.hasOwn(status, id)) return [f]
              const now = status[id]
              if (now.state === 'fetching') return [f]
              if (now.state === 'done') return []
              return [{ ...f, state: { kind: 'refused', reason: now.reason } }]
            }),
          )
          // The job filed a row: show it.
          if (Object.values(status).some((s) => s.state === 'done'))
            void router.invalidate()
        },
        () => undefined,
      )
    }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [polling, router])

  return { fetches, attach, attachPicked, dismiss }
}

const FOLDER_REFUSAL =
  'That’s a folder. Link a Drive folder instead to keep it in sync.'

/** One pasted link or picked file that has not become a row yet. */
export function LinkFetchRow({
  fetch,
  onDismiss,
  onLinkFolder = null,
}: {
  fetch: LinkFetch
  onDismiss: () => void
  /** Opens Link a Drive folder for a refused folder link. */
  onLinkFolder?: ((url: string) => void) | null
}) {
  const { state } = fetch
  const inFlight = state.kind === 'sending' || state.kind === 'fetching'
  const reason =
    state.kind === 'refused'
      ? state.reason
      : state.kind === 'folder'
        ? FOLDER_REFUSAL
        : state.kind === 'connect'
          ? `Connect your Google ${fetch.label} to fetch this file.`
          : null
  return (
    <li
      className={cn(
        'flex min-h-ledger-row items-center gap-3 border-b border-rule px-3 py-1.5',
        inFlight && 'bg-selected',
      )}
    >
      <FileGlyph type="file" pending />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'min-w-0 truncate',
            fetch.link ? 'mono text-label text-graphite' : 'text-body',
          )}
        >
          {fetch.name}
        </span>
        {reason === null ? null : (
          <span
            title={reason}
            className={cn(
              'min-w-0 truncate text-label',
              state.kind === 'connect' ? 'text-foreground' : 'text-destructive',
            )}
          >
            {reason}
          </span>
        )}
      </div>
      {inFlight ? (
        <span className="shrink-0 mono text-micro text-foreground">
          fetching.
        </span>
      ) : null}
      {state.kind === 'connect' ? (
        <Button asChild size="sm">
          <a href={state.href}>{state.action}</a>
        </Button>
      ) : null}
      {state.kind === 'folder' && onLinkFolder !== null ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onLinkFolder(state.url)}
        >
          Link folder…
        </Button>
      ) : null}
      {inFlight ? null : (
        <button
          type="button"
          aria-label={`Dismiss ${fetch.name}`}
          onClick={onDismiss}
          className="focus-ring shrink-0 mono text-micro text-graphite hover:text-foreground"
        >
          ×
        </button>
      )}
    </li>
  )
}

/**
 * The add row that opens the Files tab: `+ Drop files, or paste a Drive
 * link…`. A Drive link pasted or entered is fetched; any other link is saved
 * as a page. The tab's count and buttons ride at its end.
 */
export function AddRow({
  onLink,
  meta = null,
  children = null,
}: {
  onLink: (url: string) => void
  /** Mono beside the buttons: the tab's `n · 31 MB`. */
  meta?: ReactNode
  children?: ReactNode
}) {
  const [value, setValue] = useState('')

  const submit = (raw: string) => {
    const url = raw.trim()
    if (!URL.canParse(url)) return
    setValue('')
    onLink(url)
  }

  return (
    <div className="flex h-ledger-row shrink-0 items-center gap-3 border-b border-rule px-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit(value)
        }}
        className="flex min-w-0 flex-1 items-center gap-2.5"
      >
        <span aria-hidden className="shrink-0 text-ui text-primary">
          +
        </span>
        <input
          type="url"
          value={value}
          aria-label="Paste a Drive link"
          placeholder="Drop files, or paste a Drive link…"
          onChange={(e) => setValue(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').trim()
            if (!URL.canParse(pasted)) return
            e.preventDefault()
            submit(pasted)
          }}
          className="focus-ring-inset h-7 min-w-0 flex-1 bg-transparent text-ui placeholder:text-graphite"
        />
      </form>
      {meta === null ? null : (
        <span className="shrink-0 mono text-micro text-graphite">{meta}</span>
      )}
      {children}
    </div>
  )
}
