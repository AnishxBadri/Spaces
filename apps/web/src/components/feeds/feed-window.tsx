import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { formatSince } from '@spaces/core/format'
import { urlAtRest } from '#/components/attributes/value-editor'
import { useClock } from '#/components/clock'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { addFeed, editFeed, previewFeed } from '#/lib/server-fns'
import type { FeedPreview, FeedSource } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { FeedLogo } from './feed-logo'
import { fixNotice } from './feed-words'
import type { SpaceOption } from './feed-words'
import { SpacesField } from './spaces-field'

/**
 * The one feed window, M: Add feed, or a feed's own window (Edit, and Fix
 * when opened from a failing row's `Fix ›`). Add asks for the address and the
 * spaces only; the name comes from the feed.
 */
export type FeedWindowMode =
  | { readonly kind: 'add' }
  | {
      readonly kind: 'edit'
      readonly source: FeedSource
      readonly fix: boolean
    }

/** How long the address rests before the window looks it up. */
const PREVIEW_DEBOUNCE_MS = 450

const messageOf = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message.trim() !== '' ? err.message : fallback

export function FeedWindow({
  mode,
  onOpenChange,
  spaces,
  onSaved,
  onRemove,
}: {
  /** Null while closed. */
  mode: FeedWindowMode | null
  onOpenChange: (open: boolean) => void
  spaces: ReadonlyArray<SpaceOption>
  /** After a write lands: the table reads the sources again. */
  onSaved: () => void
  /** `Remove…` in the foot: the window closes and the confirm asks. */
  onRemove: (source: FeedSource) => void
}) {
  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      {mode === null ? null : (
        <DialogContent size="m" aria-describedby={undefined}>
          {mode.kind === 'add' ? (
            <AddFeedForm
              spaces={spaces}
              onDone={() => {
                onOpenChange(false)
                onSaved()
              }}
            />
          ) : (
            <EditFeedForm
              key={mode.source.id}
              source={mode.source}
              fix={mode.fix}
              spaces={spaces}
              onDone={() => {
                onOpenChange(false)
                onSaved()
              }}
              onRemove={() => {
                onOpenChange(false)
                onRemove(mode.source)
              }}
            />
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}

type Lookup =
  | { readonly kind: 'idle' }
  | { readonly kind: 'looking' }
  | { readonly kind: 'done'; readonly preview: FeedPreview }

/**
 * The address, looked up as it rests: a line under the field with what was
 * found, or the sentence why it will not add. A lookup that could not run
 * says nothing and leaves Add on: the add resolves the address again.
 */
function useFeedLookup(address: string): Lookup {
  const typed = address.trim()
  // The answer is kept with the address it answers, so a newer address
  // reads as still looking rather than showing the last one's feed.
  const [answer, setAnswer] = useState<{
    readonly address: string
    readonly preview: FeedPreview | null
  } | null>(null)
  const asked = useRef(0)
  useEffect(() => {
    asked.current += 1
    const ticket = asked.current
    if (typed === '') return
    const timer = setTimeout(() => {
      previewFeed({ data: { address: typed } })
        .then((preview) => {
          if (asked.current === ticket) setAnswer({ address: typed, preview })
        })
        .catch(() => {
          if (asked.current === ticket)
            setAnswer({ address: typed, preview: null })
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed])
  if (typed === '') return { kind: 'idle' }
  if (answer?.address !== typed) return { kind: 'looking' }
  return answer.preview === null
    ? { kind: 'idle' }
    : { kind: 'done', preview: answer.preview }
}

function AddFeedForm({
  spaces,
  onDone,
}: {
  spaces: ReadonlyArray<SpaceOption>
  onDone: () => void
}) {
  const ids = { url: useId(), spaces: useId() }
  const [address, setAddress] = useState('')
  const [spaceIds, setSpaceIds] = useState<Array<string>>([])
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const lookup = useFeedLookup(address)

  const blocked =
    lookup.kind === 'done' && lookup.preview._tag === 'Refused'
      ? lookup.preview.message
      : refused
  const ready = address.trim() !== '' && blocked === null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    try {
      await addFeed({ data: { address: address.trim(), spaceIds } })
      onDone()
    } catch (err) {
      setRefused(messageOf(err, 'Could not add the feed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="contents">
      <DialogHeader>
        <DialogTitle>Add feed</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.url}>Feed or site URL</Label>
          <Input
            id={ids.url}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={address}
            disabled={busy}
            aria-invalid={blocked !== null}
            onChange={(e) => {
              setAddress(e.target.value)
              // A refusal from the add belongs to the address it was made for.
              setRefused(null)
            }}
            className="mono"
          />
          {blocked !== null ? (
            <p role="alert" className="text-label text-destructive">
              {blocked}
            </p>
          ) : lookup.kind === 'looking' ? (
            <p
              data-feed-lookup="looking"
              className="flex items-center gap-2 text-label text-graphite"
            >
              <Twinkle />
              Finding the feed
            </p>
          ) : lookup.kind === 'done' && lookup.preview._tag === 'Found' ? (
            <FoundLine preview={lookup.preview} />
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.spaces}>Spaces</Label>
          <SpacesField
            id={ids.spaces}
            options={spaces}
            value={spaceIds}
            onChange={setSpaceIds}
            disabled={busy}
          />
        </div>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!ready || busy} pending={busy}>
          {busy ? (
            <>
              <Twinkle tone="paper" />
              Adding
            </>
          ) : (
            'Add feed'
          )}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** `▪ SpaceNews  spacenews.com/feed · newest 2h ago` */
function FoundLine({
  preview,
}: {
  preview: Extract<FeedPreview, { _tag: 'Found' }>
}) {
  return (
    <p data-feed-lookup="found" className="flex min-w-0 items-center gap-2">
      <FeedLogo name={preview.name} />
      <span className="shrink-0 text-ui font-medium">{preview.name}</span>
      <span className="min-w-0 truncate text-label text-graphite">
        {urlAtRest(preview.url)}
        {preview.newestSinceMs === null
          ? ''
          : ` · newest ${formatSince(preview.newestSinceMs)} ago`}
      </span>
    </p>
  )
}

function EditFeedForm({
  source,
  fix,
  spaces,
  onDone,
  onRemove,
}: {
  source: FeedSource
  fix: boolean
  spaces: ReadonlyArray<SpaceOption>
  onDone: () => void
  onRemove: () => void
}) {
  const { today } = useClock()
  const ids = { url: useId(), name: useId(), spaces: useId() }
  const [address, setAddress] = useState(source.url)
  const [name, setName] = useState(source.name)
  const [spaceIds, setSpaceIds] = useState<Array<string>>(
    source.spaces.map((s) => s.id),
  )
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const before = source.spaces.map((s) => s.id)
  const spacesChanged =
    before.length !== spaceIds.length ||
    before.some((id) => !spaceIds.includes(id))
  const addressChanged = address.trim() !== source.url
  const nameChanged = name.trim() !== source.name
  const ready =
    address.trim() !== '' &&
    name.trim() !== '' &&
    (addressChanged || nameChanged || spacesChanged)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setRefused(null)
    try {
      await editFeed({
        data: {
          id: source.id,
          ...(addressChanged ? { address: address.trim() } : {}),
          ...(nameChanged ? { name: name.trim() } : {}),
          ...(spacesChanged ? { spaceIds } : {}),
        },
      })
      onDone()
    } catch (err) {
      setRefused(messageOf(err, 'Could not save the feed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="contents">
      <DialogHeader>
        <DialogTitle>{source.name}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        {fix && source.state === 'failing' ? (
          <p
            data-feed-notice
            className="flex items-start gap-2.5 border border-rule bg-bone px-3 py-2.5 text-ui"
          >
            <span
              aria-hidden
              className="mt-1.75 size-1.5 shrink-0 bg-destructive"
            />
            {fixNotice(source, today)}
          </p>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.url}>Feed URL</Label>
          <Input
            id={ids.url}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={address}
            disabled={busy}
            onChange={(e) => setAddress(e.target.value)}
            className="mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.name}>Name</Label>
          <Input
            id={ids.name}
            autoComplete="off"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.spaces}>Spaces</Label>
          <SpacesField
            id={ids.spaces}
            options={spaces}
            value={spaceIds}
            onChange={setSpaceIds}
            disabled={busy}
          />
        </div>
        {refused === null ? null : (
          <p role="alert" className="text-label text-destructive">
            {refused}
          </p>
        )}
      </div>
      <DialogFooter>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className={cn(
            'focus-ring mr-auto rounded-md text-ui font-medium text-destructive hover:underline',
            busy && 'opacity-50',
          )}
        >
          Remove…
        </button>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!ready || busy} pending={busy}>
          {busy ? (
            <>
              <Twinkle tone="paper" />
              Saving
            </>
          ) : (
            'Save'
          )}
        </Button>
      </DialogFooter>
    </form>
  )
}
