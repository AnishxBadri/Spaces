import { useRouter } from '@tanstack/react-router'
import { icon } from '#/components/icons'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import type { PickedEntity } from '#/lib/documents/file-against'
import { clipUrl, searchEntities } from '#/lib/server-fns'

/**
 * The two ways in that keep a step of their own, opened from the Files
 * page's `Upload` menu. A file from this computer needs none: it lands
 * unfiled as a row (`addFiles`).
 * - `From Google Drive…` asks which record first: a picked Drive file is
 *   fetched by the worker onto a record, never unfiled.
 * - `Paste a link` takes the address and saves the page unfiled.
 */

/** Which record Drive's picked files go on; `Choose in Drive…` opens the picker. */
export function FromDriveDialog({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (record: PickedEntity) => void
}) {
  const [picked, setPicked] = useState<PickedEntity | null>(null)
  useEffect(() => {
    if (open) setPicked(null)
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s">
        <DialogHeader>
          <DialogTitle>From Google Drive</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <p className="text-label text-graphite">File under</p>
          <RecordPicker picked={picked} onPick={setPicked} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={picked === null}
            onClick={() => {
              if (picked === null) return
              onOpenChange(false)
              onChoose(picked)
            }}
          >
            Choose in Drive…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * **Paste a link**: the page is saved unfiled, a document like any other.
 * The call returns before any network call: the server writes the row and
 * the worker fetches, so the row reads as being read until the job lands.
 * A refusal (an intranet address, a `file://`) is the guard's own sentence.
 */
export function PasteLinkDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setUrl('')
  }, [open])

  const armed = url.trim() !== '' && !saving

  async function save() {
    const link = url.trim()
    if (link === '') return
    setSaving(true)
    try {
      await clipUrl({ data: { url: link, fileAgainst: [] } })
      toast.success('Link saved · Unfiled')
      onOpenChange(false)
      void router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save this link',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s">
        <DialogHeader>
          <DialogTitle>Paste a link</DialogTitle>
        </DialogHeader>
        <Input
          value={url}
          type="url"
          inputMode="url"
          autoFocus
          aria-label="Paste a link"
          placeholder="https://…"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves: the field is not a form, so there is no implicit
            // submit to lean on.
            if (e.key === 'Enter' && armed) {
              e.preventDefault()
              void save()
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!armed} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Records are unbounded, so this is the debounced search the Files tab's
 * filing popover and the note page's filing row draw. `kinds` is
 * **explicit**: the default lane includes documents (for mentions), and a
 * document filed against a document is a mention, not a filing. The server
 * refuses those targets either way (`documentFilingRefusal`).
 */
function RecordPicker({
  picked,
  onPick,
}: {
  picked: PickedEntity | null
  onPick: (p: PickedEntity | null) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<
    Awaited<ReturnType<typeof searchEntities>>
  >([])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        try {
          const rows = await searchEntities({
            data: { q: query, kinds: ['company', 'person', 'deal', 'custom'] },
          })
          if (alive) setResults(rows)
        } catch {
          if (alive) setResults([])
        }
      })()
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  if (picked) {
    return (
      <span className="flex h-8 w-fit items-center gap-1.5 border border-rule bg-paper pr-1.5 pl-2.5 text-ui">
        {picked.name}
        <button
          type="button"
          aria-label={`Clear ${picked.name}`}
          onClick={() => onPick(null)}
          className="focus-ring text-graphite hover:text-foreground"
        >
          <icon.close className="size-4" />
        </button>
      </span>
    )
  }

  return (
    <div>
      <Input
        value={query}
        autoFocus
        aria-label="Search records"
        placeholder="Search companies, people, deals…"
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 ? (
        <ul className="mt-1 max-h-40 overflow-y-auto border border-hairline bg-paper shadow-dither">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick({ entityId: r.id, name: r.name })
                  setQuery('')
                }}
                className="focus-ring-inset flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-ui hover:bg-bone"
              >
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="label-caps text-graphite">{r.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {query.trim() && results.length === 0 ? (
        <p className="mt-1 text-label text-graphite">No record matches.</p>
      ) : null}
    </div>
  )
}
