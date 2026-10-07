import { useRouter } from '@tanstack/react-router'
import { File as FileIcon, Link2, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { attachFromLink, linkFetchStatus } from '#/lib/server-fns'
import { storageLinkProvider } from '#/lib/documents/storage-link'
import { cn } from '#/lib/utils'

/**
 * Attach from a link on the Files tab: the paste row, and the pending rows a
 * pasted Drive link shows while the worker fetches it.
 * - A fetch takes seconds, not an upload's phases: its row reads "Fetching
 *   from Drive…" until the job settles, then the filed row replaces it.
 * - A refusal stays on its row with the provider's reason; no connection
 *   offers Connect there. Either is dismissed by hand.
 */

export type LinkFetch = {
  readonly key: string
  readonly url: string
  readonly label: string
  readonly state:
    | { readonly kind: 'sending' }
    | { readonly kind: 'fetching'; readonly fetchId: string }
    | {
        readonly kind: 'connect'
        readonly href: string
        readonly action: string
      }
    | { readonly kind: 'refused'; readonly reason: string }
}

const POLL_MS = 2000

/** The link without its scheme, for a row's name. */
const shown = (url: string) => url.replace(/^https?:\/\//, '')

/** Pasted links on one record, polled while any is fetching. */
export function useLinkFetches(entityId: string) {
  const router = useRouter()
  const [fetches, setFetches] = useState<Array<LinkFetch>>([])

  const update = (key: string, state: LinkFetch['state']) =>
    setFetches((all) => all.map((f) => (f.key === key ? { ...f, state } : f)))

  async function attach(url: string) {
    const provider = storageLinkProvider(url)
    const key = `${url}-${Math.random()}`
    setFetches((all) => [
      ...all,
      {
        key,
        url,
        label: provider?.label ?? 'the link',
        state: { kind: 'sending' },
      },
    ])
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

  return { fetches, attach, dismiss }
}

/** One pasted link that has not become a row yet. */
export function LinkFetchRow({
  fetch,
  onDismiss,
}: {
  fetch: LinkFetch
  onDismiss: () => void
}) {
  const { state } = fetch
  const failed = state.kind === 'refused'
  const settled = state.kind === 'refused' || state.kind === 'connect'
  return (
    <li className="flex h-9 items-center gap-2.5 border-t border-rule px-3 text-ui first:border-t-0">
      <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper">
        {settled ? (
          <FileIcon
            className={cn(
              'size-3',
              failed ? 'text-destructive' : 'text-graphite',
            )}
            strokeWidth={1.75}
          />
        ) : (
          <Loader2
            className="size-3 animate-spin text-graphite motion-reduce:animate-none"
            strokeWidth={1.75}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{shown(fetch.url)}</span>
      {state.kind === 'connect' ? (
        <a
          href={state.href}
          className="focus-ring shrink-0 text-ui text-primary hover:underline"
        >
          {state.action}
        </a>
      ) : (
        <span
          className={cn(
            'min-w-0 shrink truncate mono text-micro',
            failed ? 'text-destructive' : 'text-graphite',
          )}
          title={failed ? state.reason : undefined}
        >
          {state.kind === 'refused'
            ? state.reason
            : `Fetching from ${fetch.label}…`}
        </span>
      )}
      {settled ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Dismiss ${shown(fetch.url)}`}
          onClick={onDismiss}
          className="text-graphite"
        >
          <X />
        </Button>
      ) : null}
    </li>
  )
}

/**
 * The paste row under the list: a Drive link pasted or entered here is
 * fetched; any other link is saved as a page, as a dropped one is.
 */
export function LinkPasteRow({ onLink }: { onLink: (url: string) => void }) {
  const [value, setValue] = useState('')

  const submit = (raw: string) => {
    const url = raw.trim()
    if (!URL.canParse(url)) return
    setValue('')
    onLink(url)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit(value)
      }}
      className="flex h-9 items-center gap-2.5 border-b border-rule px-3"
    >
      <Link2 className="size-3 shrink-0 text-graphite" strokeWidth={2} />
      <input
        type="url"
        value={value}
        aria-label="Paste a Drive link"
        placeholder="…or paste a Drive link"
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
  )
}
