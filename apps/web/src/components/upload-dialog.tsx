import { useRouter } from '@tanstack/react-router'
import { File as FileIcon, Check, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Segmented } from '#/components/ui/segmented'
import { Select } from '#/components/ui/select'
import { formatBytes, MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import {
  fileAgainstFor,
  filingNote,
  uploadTarget,
} from '#/lib/documents/file-against'
import type { FilingMode, PickedEntity } from '#/lib/documents/file-against'
import { uploadDocument } from '#/lib/documents/upload'
import type { UploadPhase } from '#/lib/documents/upload'
import { listSpaces, searchEntities } from '#/lib/server-fns'
import {
  setUploadDialogOpen,
  useUploadDialogOpen,
} from '#/lib/upload-dialog-store'
import { cn } from '#/lib/utils'

/**
 * **The global upload** — §3.1 entry point 3 (SPA-108).
 *
 * Every byte entered through a record's Files tab until this slice, so a deck
 * that arrived before you knew whose it was had nowhere to land. This is the
 * one surface where the filing is a question: a record, a space, or nowhere,
 * defaulting to **nowhere** — an unfiled document is §3.2's inbox row, not an
 * orphan, and the writer has accepted an empty `fileAgainst` since SPA-113.
 *
 * Three entry points, one component: the `/documents` header, the chassis'
 * Upload row, and ⌘K's "Upload a file…". None of them owns it — it is mounted
 * once in the app shell and opened through `lib/upload-dialog-store.ts`, so a
 * fourth surface costs one call and no prop.
 *
 * **It never aborts.** Closing the dialog mid-upload closes Radix's content,
 * not this component, so an in-flight file keeps running in the state below
 * and lands as a toast. The two outcomes are therefore the only two there
 * are: `finalizeDocumentUpload` completed and a row exists, or the browser
 * lane failed before it — a PUT that never finished, a tab closed — in which
 * case there is no row at all and the bytes sit in the store as garbage for
 * the blob GC (SPA-54) to collect. Nothing in between: the row is written by
 * one transaction, and no half of it is written by the browser. The dialog
 * says which, in the foot and in the toast on close.
 *
 * The hasher is `lib/documents/upload.ts` and only that (SPA-71) — the size
 * guard, the secure-context check and the already-stored short circuit all
 * live there, and this surface passes it the drop's one target per file.
 */

/** A file this dialog started, terminal or not. */
type Upload = {
  key: string
  name: string
  phase: UploadPhase
  /** `finalizeDocumentUpload` returned — the row exists. */
  done?: boolean
  /** Its own failure, which never touches the other files in the drop. */
  error?: string
}

const PHASE_LABELS: Record<UploadPhase, string> = {
  hashing: 'Reading…',
  uploading: 'Uploading…',
  filing: 'Filing…',
}

const MODES: Array<{ id: FilingMode; label: string }> = [
  { id: 'unfiled', label: 'Unfiled' },
  { id: 'record', label: 'A record' },
  { id: 'space', label: 'A space' },
]

export function UploadDialog() {
  const router = useRouter()
  const open = useUploadDialogOpen()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [mode, setMode] = useState<FilingMode>('unfiled')
  const [picked, setPicked] = useState<PickedEntity | null>(null)
  const [uploads, setUploads] = useState<Array<Upload>>([])

  const target = uploadTarget(mode, picked)
  const working = uploads.filter((u) => !u.done && u.error === undefined)

  // Each opening is a new drop: the picker starts at Unfiled, as §3.1 says it
  // defaults, and last session's finished rows are history. Anything still
  // running is not — it stays on the list it is still writing to.
  useEffect(() => {
    if (!open) return
    setMode('unfiled')
    setPicked(null)
    setDragging(false)
    setUploads((u) => u.filter((x) => !x.done && x.error === undefined))
  }, [open])

  function onOpenChange(next: boolean) {
    setUploadDialogOpen(next)
    if (!next && working.length > 0) {
      toast.message('Uploads continue in the background')
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || target === null) return
    // Read once, for the drop: the reader answered "where" a single time, and
    // four files dropped together file against that one answer even if the
    // picker is changed while the third is still hashing.
    const fileAgainst = fileAgainstFor(target)
    const where = target.kind === 'unfiled' ? 'Unfiled' : target.name

    for (const file of Array.from(files)) {
      const key = `${file.name}-${String(file.size)}-${String(Math.random())}`
      setUploads((u) => [...u, { key, name: file.name, phase: 'hashing' }])
      const setPhase = (phase: UploadPhase) =>
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, phase } : x)))
      try {
        await uploadDocument({ file, fileAgainst, onPhase: setPhase })
        setUploads((u) =>
          u.map((x) => (x.key === key ? { ...x, done: true } : x)),
        )
        toast.success(`${file.name} · ${where}`)
        // So `/documents`, a Files tab or a space's Sources shows it without
        // the reader reloading the page they uploaded from.
        void router.invalidate()
      } catch (err) {
        // Caught per file and inside the loop: one 300MB deck refused by the
        // size guard must not take the three good files after it with it.
        const message = err instanceof Error ? err.message : 'Upload failed'
        setUploads((u) =>
          u.map((x) => (x.key === key ? { ...x, error: message } : x)),
        )
        toast.error(`${file.name}: ${message}`)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[35rem]">
        <DialogHeader>
          <DialogTitle>Upload a file</DialogTitle>
          <DialogDescription>
            stays on this server · up to {formatBytes(MAX_UPLOAD_BYTES)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="field-label text-graphite">File against</p>
            <Segmented
              label="File against"
              value={mode}
              options={MODES}
              onChange={(next) => {
                setMode(next)
                setPicked(null)
              }}
            />
            {mode === 'record' ? (
              <RecordPicker picked={picked} onPick={setPicked} />
            ) : null}
            {mode === 'space' ? (
              <SpacePicker picked={picked} onPick={setPicked} />
            ) : null}
            {mode === 'unfiled' ? (
              <p className="text-label text-graphite">
                It lands in the inbox with no record and no space. File it later
                from the row — the file and its text stay either way.
              </p>
            ) : null}
          </div>

          {uploads.length > 0 ? (
            <ul className="flex flex-col border-t border-rule">
              {uploads.map((u) => (
                <li
                  key={u.key}
                  className="flex h-9 items-center gap-2.5 border-b border-rule text-ui"
                >
                  <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper">
                    {u.error ? (
                      <FileIcon
                        className="size-3 text-destructive"
                        strokeWidth={1.75}
                      />
                    ) : u.done ? (
                      <Check className="size-3 text-primary" strokeWidth={2} />
                    ) : (
                      <Loader2
                        className="size-3 animate-spin text-graphite motion-reduce:animate-none"
                        strokeWidth={1.75}
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <span
                    className={cn(
                      'mono text-micro',
                      u.error ? 'text-destructive' : 'text-graphite',
                    )}
                  >
                    {u.error ?? (u.done ? 'filed' : PHASE_LABELS[u.phase])}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* The dropzone the Files tab draws, with one difference: it is
              disarmed until the target is answerable, because "a record, but
              none picked" must not quietly become unfiled. */}
          <button
            type="button"
            disabled={target === null}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              if (target !== null) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              void handleFiles(e.dataTransfer.files)
            }}
            className={cn(
              'focus-ring flex h-18 w-full flex-col items-center justify-center gap-1 border border-dashed transition-colors disabled:opacity-50',
              dragging
                ? 'border-primary bg-selected text-primary'
                : 'border-hairline bg-paper text-foreground hover:bg-bone',
            )}
          >
            <span className="text-ui">
              {target === null
                ? mode === 'record'
                  ? 'Choose a record first'
                  : 'Choose a space first'
                : dragging
                  ? 'Release to upload'
                  : 'Drop files, or click'}
            </span>
            <span className="mono text-field text-graphite">
              {filingNote(target)}
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => {
              void handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        <DialogFooter
          note={
            working.length > 0
              ? `${String(working.length)} uploading · continues in the background`
              : 'one target for every file in the drop'
          }
        >
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Records are unbounded, so this is the debounced search the Files tab's
 * filing popover and the note page's filing row already draw — and `kinds` is
 * **explicit** for the same reason it is there: SPA-27 widened the default
 * lane to include documents so a deck could be mentioned in a note body, and
 * a document filed against a document is a mention, not a filing. The server
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
          <X className="size-2.5" strokeWidth={2} />
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
        <ul className="mt-1 max-h-40 overflow-y-auto border border-hairline bg-paper shadow-[2px_2px_0_0_var(--hairline)]">
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
                <span className="mono text-micro text-graphite">{r.kind}</span>
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

/**
 * Spaces are a tree of a few dozen, so they are a `Select` with the depth the
 * rail indents by — the rail's pattern, and the Files tab's space lane. The
 * list is fetched when this mode is chosen rather than in the shell's loader:
 * every page in the app mounts this dialog, and almost nobody opens it.
 */
function SpacePicker({
  picked,
  onPick,
}: {
  picked: PickedEntity | null
  onPick: (p: PickedEntity) => void
}) {
  const [spaces, setSpaces] = useState<Awaited<ReturnType<typeof listSpaces>>>(
    [],
  )

  useEffect(() => {
    // A cell rather than a `let`: the flag is read after an `await`, where a
    // local boolean reads as always-true to the compiler.
    const live = { current: true }
    void (async () => {
      try {
        const rows = await listSpaces()
        if (live.current) setSpaces(rows)
      } catch {
        // A picker that cannot list is an empty picker; the drop zone stays
        // disarmed and says so, which is the honest report either way.
        if (live.current) setSpaces([])
      }
    })()
    return () => {
      live.current = false
    }
  }, [])

  return (
    <Select
      aria-label="File this upload into a space"
      value={picked?.entityId ?? ''}
      onChange={(id) => {
        const row = spaces.find((s) => s.id === id)
        if (row) onPick({ entityId: row.id, name: row.name })
      }}
      items={spaces.map((s) => ({
        value: s.id,
        label: s.name,
        depth: s.depth,
      }))}
      width="content"
      placeholder="Choose a space…"
      searchPlaceholder="Search spaces…"
      emptyLabel="No space matches."
    />
  )
}
