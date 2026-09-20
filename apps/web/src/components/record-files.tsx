import { Link, useRouter } from '@tanstack/react-router'
import {
  Download,
  Eye,
  File as FileIcon,
  FolderTree,
  Layers,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { useConfirm } from './ui/confirm-dialog'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Select } from './ui/select'
import { DocumentPreview } from './document-preview'
import { KIND_ICONS } from './editor/mention'
import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  guessDocumentKind,
} from '@spaces/core/documents'
import { formatDurationMs, formatSince } from '@spaces/core/format'
import {
  deleteDocument,
  fileDocument,
  finalizeDocumentUpload,
  getDocumentDownloadUrl,
  listSpaces,
  prepareDocumentUpload,
  reExtractDocument,
  searchEntities,
  setDocumentKind,
  unfileDocument,
} from '#/lib/server-fns'
import type { listRecordDocuments } from '#/lib/server-fns'
import { recordPath } from '#/lib/record-path'
import { cn } from '#/lib/utils'

/**
 * The Files tab. Documents hang off entities, not folders — folders are the
 * thing being replaced, so this is a flat list per record, not a tree.
 *
 * Upload never streams through a server function: the file is hashed in the
 * browser, PUT straight at storage, and only then filed as a row. Extraction
 * happens on the worker afterwards, so a freshly uploaded document is
 * legitimately textless for a second or two — the row says so rather than
 * pretending.
 */

type Documents = Awaited<ReturnType<typeof listRecordDocuments>>

/** In-flight uploads, shown alongside the filed rows. */
type Pending = {
  key: string
  name: string
  phase: 'hashing' | 'uploading' | 'filing'
  error?: string
}

const PHASE_LABELS: Record<Pending['phase'], string> = {
  hashing: 'Reading…',
  uploading: 'Uploading…',
  filing: 'Filing…',
}

export function RecordFiles({
  entityId,
  documents,
}: {
  entityId: string
  documents: Documents
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState<Array<Pending>>([])
  const [previewing, setPreviewing] = useState<Documents[number] | null>(null)

  useExtractionPolling(documents, router)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${pending.length}-${Math.random()}`
      setPending((p) => [...p, { key, name: file.name, phase: 'hashing' }])
      const setPhase = (phase: Pending['phase']) =>
        setPending((p) => p.map((x) => (x.key === key ? { ...x, phase } : x)))
      try {
        await uploadOne(file, entityId, setPhase)
        setPending((p) => p.filter((x) => x.key !== key))
        void router.invalidate()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, error: message } : x)),
        )
        toast.error(`${file.name}: ${message}`)
      }
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void handleFiles(e.dataTransfer.files)
      }}
      className="flex flex-col"
    >
      <div className="flex h-8 items-center justify-between border-t border-rule">
        <p className="mono text-micro text-graphite">
          {documents.length === 0
            ? 'decks, memos, cap tables — drop them here'
            : `${documents.length} file${documents.length === 1 ? '' : 's'} · ${formatBytes(documents.reduce((n, d) => n + (d.sizeBytes ?? 0), 0))}`}
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="focus-ring flex items-center gap-1 mono text-micro text-primary hover:underline"
        >
          <Upload className="size-3" strokeWidth={2} />
          upload
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

      {documents.length > 0 || pending.length > 0 ? (
        <ul className="flex flex-col">
          {pending.map((p) => (
            <li
              key={p.key}
              className="flex h-9 items-center gap-2.5 border-t border-rule text-ui"
            >
              <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper">
                {p.error ? (
                  <FileIcon
                    className="size-3 text-destructive"
                    strokeWidth={1.75}
                  />
                ) : (
                  <Loader2
                    className="size-3 animate-spin text-graphite motion-reduce:animate-none"
                    strokeWidth={1.75}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span
                className={cn(
                  'mono text-micro',
                  p.error ? 'text-destructive' : 'text-graphite',
                )}
              >
                {p.error ?? PHASE_LABELS[p.phase]}
              </span>
            </li>
          ))}
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              onPreview={() => setPreviewing(doc)}
            />
          ))}
        </ul>
      ) : null}

      {/* The dropzone: dashed hairline at rest, pine dashed on the selection
          wash while a drag is over it. Click opens the picker. */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={cn(
          'focus-ring mt-2 flex h-18 w-full flex-col items-center justify-center gap-1 border border-dashed transition-colors',
          dragging
            ? 'border-primary bg-selected text-primary'
            : 'border-hairline bg-paper text-foreground hover:bg-bone',
        )}
      >
        <span className="text-ui">
          {dragging ? 'Release to attach' : 'Drop files, or click'}
        </span>
        <span className="mono text-field text-graphite">
          {dragging
            ? 'they stay on this server'
            : 'stays on this server · PDF, DOCX, PPTX, XLSX get their text extracted'}
        </span>
      </button>

      <DocumentPreview
        doc={previewing}
        onOpenChange={(open) => !open && setPreviewing(null)}
      />
    </div>
  )
}

function DocumentRow({
  doc,
  onPreview,
}: {
  doc: Documents[number]
  onPreview: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function download() {
    try {
      const { url } = await getDocumentDownloadUrl({ data: { id: doc.id } })
      window.location.href = url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download')
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete ${doc.filename}?`,
      body: 'It leaves this record and the server. This cannot be undone.',
      action: 'Delete',
    })
    if (!ok) return
    setBusy(true)
    try {
      await deleteDocument({ data: { id: doc.id } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
      setBusy(false)
    }
  }

  const code = KIND_CODES[doc.kind] ?? extCode(doc.filename)

  return (
    <li className="group flex min-h-9 items-center gap-2.5 border-t border-rule py-1 text-ui">
      <span
        /* Optical sizing, not a type step: a three-letter kind code has to sit
           inside a 22px square, and the smallest named step (field, 10px)
           overflows it. DESIGN.md §3's list is for type; this is a glyph. */
        // eslint-disable-next-line instrument/vocabulary
        className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper mono text-[0.5rem] leading-[0.625rem] text-foreground"
      >
        {code}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={onPreview}
          title={`Preview ${doc.filename}`}
          className="focus-ring min-w-0 truncate text-left leading-4 hover:underline"
        >
          {doc.filename}
        </button>
        <span className="truncate mono text-field text-graphite">
          {[
            DOCUMENT_KIND_LABELS[doc.kind].toLowerCase(),
            formatBytes(doc.sizeBytes),
            doc.createdAt.slice(5, 10),
            doc.uploadedByName,
            // Named, not classed (SPA-137): the reader installed "gmail" and
            // that is the word they know — "integration" would tell them
            // nothing they could act on. A hand-uploaded file gets no suffix
            // at all, because "via nobody" is noise on every row but the few
            // a connector filed. The server resolved the ref to the
            // capability id; this line only prints it.
            doc.sourceCapability ? `via ${doc.sourceCapability}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <ExtractionNote doc={doc} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <FilingControl doc={doc} />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Preview ${doc.filename}`}
          onClick={onPreview}
          className="text-graphite opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Eye />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Download ${doc.filename}`}
          onClick={download}
          className="text-graphite"
        >
          <Download />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          aria-label={`Delete ${doc.filename}`}
          onClick={remove}
          className="text-graphite opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
        >
          <Trash2 />
        </Button>
      </div>
      {confirmDialog}
    </li>
  )
}

/**
 * The filing control (SPA-50) — §3.3's re-file, change kind and re-extract,
 * on the row they act on.
 *
 * A document is filed in N places (§3.4): the deck lives on the company *and*
 * the deal without copying, and until this control existed the set was
 * whatever the upload said. So the popover shows **every** edge, not just
 * this tab's — records routed through `recordPath`, spaces to their page —
 * each with a remove control, and two pickers to add more.
 *
 * Removing the edge to the record whose tab this is takes the row off this
 * tab on the next `router.invalidate()`. That is the point, and it is not a
 * delete: the row, the blob and the extracted text all stay, and an unfiled
 * document is a first-class state rather than an orphan.
 */
function FilingControl({ doc }: { doc: Documents[number] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        await router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not file')
      } finally {
        setBusy(false)
      }
    },
    [router],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Filing for ${doc.filename}`}
          title={`Filed in ${String(doc.filedIn.length)} place${doc.filedIn.length === 1 ? '' : 's'}`}
          className="text-graphite"
        >
          <FolderTree />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="field-label text-graphite">Filed in</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {doc.filedIn.length === 0 ? (
            <p className="text-label text-graphite">
              Nowhere. The file and its text stay either way.
            </p>
          ) : null}
          {doc.filedIn.map((edge) => (
            <FilingChip
              key={`${edge.kind}-${edge.id}`}
              edge={edge}
              busy={busy}
              onRemove={() =>
                void run(() =>
                  unfileDocument({
                    data: {
                      documentId: doc.id,
                      target: { kind: edge.kind, entityId: edge.id },
                    },
                  }),
                )
              }
            />
          ))}
        </div>

        <RecordPicker
          disabled={busy}
          filedIds={doc.filedIn.map((e) => e.id)}
          onPick={(entityId) =>
            void run(() =>
              fileDocument({
                data: {
                  documentId: doc.id,
                  target: { kind: 'record', entityId },
                },
              }),
            )
          }
        />

        <SpacePicker
          open={open}
          disabled={busy}
          filedIds={doc.filedIn.map((e) => e.id)}
          onPick={(entityId) =>
            void run(() =>
              fileDocument({
                data: {
                  documentId: doc.id,
                  target: { kind: 'space', entityId },
                },
              }),
            )
          }
        />

        {/* Kind and extraction: the other two §3.3 actions, below the edges
            because neither moves the document — a genre and a re-read. */}
        <div className="mt-3 flex items-center gap-1.5 border-t border-rule pt-3">
          <Select
            aria-label={`Kind of ${doc.filename}`}
            value={doc.kind}
            disabled={busy}
            onChange={(kind) =>
              void run(() =>
                setDocumentKind({ data: { documentId: doc.id, kind } }),
              )
            }
            items={DOCUMENT_KINDS.map((k) => ({
              value: k,
              label: DOCUMENT_KIND_LABELS[k],
            }))}
            width="content"
            className="h-6 w-auto flex-1 text-label"
          />
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { queued } = await reExtractDocument({
                  data: { documentId: doc.id },
                })
                // The row is `pending` either way and re-queueable; say so
                // rather than letting a down worker look like a done job.
                if (!queued) toast.message('Queued when the worker is back')
              })
            }
          >
            <RefreshCw className="size-3" strokeWidth={2} />
            Re-extract
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** One edge, as the square chip the note page's filing rows already draw. */
function FilingChip({
  edge,
  busy,
  onRemove,
}: {
  edge: Documents[number]['filedIn'][number]
  busy: boolean
  onRemove: () => void
}) {
  // A custom record routes through its object's slug; a kind with no page
  // reads as plain text rather than a broken link.
  const href =
    edge.kind === 'space'
      ? `/spaces/${edge.id}`
      : recordPath({
          kind: edge.entityKind,
          id: edge.id,
          objectSlug: edge.objectSlug,
        })
  const Icon = edge.kind === 'space' ? Layers : KIND_ICONS[edge.entityKind]

  return (
    <span className="flex h-6 items-center gap-1.5 border border-rule bg-paper pr-1.5 pl-2 text-label font-medium">
      {Icon ? <Icon className="size-2.5 shrink-0" strokeWidth={1.75} /> : null}
      {href ? (
        <Link to={href} className="focus-ring hover:underline">
          {edge.name}
        </Link>
      ) : (
        edge.name
      )}
      <button
        type="button"
        aria-label={`Unfile from ${edge.name}`}
        disabled={busy}
        onClick={onRemove}
        className="focus-ring mono text-micro text-graphite hover:text-foreground"
      >
        ×
      </button>
    </span>
  )
}

/**
 * Records are unbounded where spaces are a tree of a few dozen, so this is a
 * debounced search — the lane `RecordFilingPicker` on the note page and
 * `value-editor.tsx`'s reference picker already draw.
 *
 * The `kinds` argument is **explicit** and names four: SPA-27 widened the
 * default lane to include documents so a deck could be mentioned in a note
 * body, and a document filed against a document is a mention, not a filing.
 * A client allowlist is a convenience either way — `fileDocumentProgram`
 * refuses the same targets, and `searchEntities` already drops merged-away
 * rows in SQL.
 */
function RecordPicker({
  filedIds,
  disabled,
  onPick,
}: {
  filedIds: Array<string>
  disabled: boolean
  onPick: (entityId: string) => void
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
        const rows = await searchEntities({
          data: { q: query, kinds: ['company', 'person', 'deal', 'custom'] },
        })
        if (alive) setResults(rows)
      })()
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  const offered = results.filter((r) => !filedIds.includes(r.id))

  return (
    <div className="mt-3">
      <Input
        value={query}
        disabled={disabled}
        placeholder="File against a record…"
        onChange={(e) => setQuery(e.target.value)}
        className="h-7 text-label"
      />
      {offered.length > 0 ? (
        <ul className="mt-1 flex flex-col">
          {offered.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onPick(r.id)
                  setQuery('')
                }}
                className="focus-ring flex h-7 w-full items-center px-2 text-left text-ui hover:bg-bone"
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {query.trim() && offered.length === 0 ? (
        <p className="mt-1 px-2 text-label text-graphite">No record matches.</p>
      ) : null}
    </div>
  )
}

/**
 * The space lane. Its value stays empty so the trigger keeps reading as an
 * invitation rather than as a held choice — `SpaceFiling`'s picker on the
 * note page, with the same nesting as the filter popover's attribute picker.
 *
 * The list is fetched when the popover opens rather than in four route
 * loaders: a Files tab with twelve rows would otherwise pay for the whole
 * space tree twelve times to draw twelve popovers nobody clicked.
 */
function SpacePicker({
  open,
  filedIds,
  disabled,
  onPick,
}: {
  open: boolean
  filedIds: Array<string>
  disabled: boolean
  onPick: (entityId: string) => void
}) {
  const [spaces, setSpaces] = useState<Awaited<ReturnType<typeof listSpaces>>>(
    [],
  )

  useEffect(() => {
    if (!open) return
    // A cell rather than a `let`: the flag is read after an `await`, and a
    // local boolean reads as always-true to the compiler there, which is
    // `no-unnecessary-condition`'s complaint and not a wrong one.
    const live = { current: true }
    void (async () => {
      try {
        const rows = await listSpaces()
        if (live.current) setSpaces(rows)
      } catch {
        // A picker that cannot list is an empty picker, not a toast on a
        // popover the reader opened to do something else.
        if (live.current) setSpaces([])
      }
    })()
    return () => {
      live.current = false
    }
  }, [open])

  const unfiled = spaces.filter((s) => !filedIds.includes(s.id))
  if (unfiled.length === 0) return null

  return (
    <div className="mt-1.5">
      <Select
        aria-label="File this document into a space"
        value=""
        disabled={disabled}
        onChange={onPick}
        items={unfiled.map((s) => ({
          value: s.id,
          label: s.name,
          depth: s.depth,
        }))}
        width="content"
        placeholder="+ File into a space…"
        searchPlaceholder="Search spaces…"
        emptyLabel="No space matches."
        className="h-7 w-full rounded-none border-dashed bg-transparent px-2 text-label text-graphite hover:text-foreground"
      />
    </div>
  )
}

/** The three-letter tile: the kind when it says something, else the extension. */
const KIND_CODES: Record<string, string> = {
  deck: 'DCK',
  cap_table: 'CAP',
  memo: 'MEM',
  dd: 'DD',
  legal: 'LGL',
}

function extCode(filename: string): string {
  const ext = filename.split('.').pop()?.toUpperCase() ?? ''
  return ext.length > 0 && ext.length <= 4 ? ext.slice(0, 3) : 'FILE'
}

/**
 * "Extracting", "no text layer", and "extraction broke" are three different
 * facts, and only the last one is a problem — a scanned deck is a normal
 * document, not a failure.
 *
 * A broken one also gets the attempt ledger's side of the story (SPA-106):
 * which attempt of the extract job wrote this, how long that attempt ran, and
 * how long ago. Until `job_run` existed the row said only *what* went wrong,
 * never *when* or *how many times* — so a queue that had quietly retried
 * three times over an hour looked identical to one that failed once a second
 * ago. A healthy document gets none of it: nothing to observe.
 */
function ExtractionNote({ doc }: { doc: Documents[number] }) {
  if (doc.extractionStatus === 'pending') {
    return <p className="mono text-field text-graphite">extracting text…</p>
  }
  if (doc.extractionStatus === 'failed') {
    return (
      <>
        <p className="mono text-field text-destructive">
          text extraction failed — {doc.extractionError}
        </p>
        <RunNote run={doc.lastRun} />
      </>
    )
  }
  if (doc.extractionStatus === 'unsupported') {
    return (
      <p className="mono text-field text-graphite">
        {doc.extractionError ?? 'no extractable text'}
      </p>
    )
  }
  if (doc.snippet) {
    return (
      <p className="mt-1 truncate text-label text-graphite">{doc.snippet}</p>
    )
  }
  return null
}

/**
 * The wrapper's row, read back. `duration_ms` and `attempt` come from
 * `job_run` and exist for every queue, so this line is the same line an
 * Integrations page will show for a plugin job — extraction is just its first
 * reader. Both magnitudes are formatted from numbers the server computed, not
 * from the browser's clock, which is what keeps the string stable across
 * hydration.
 */
function RunNote({ run }: { run: Documents[number]['lastRun'] }) {
  if (!run) return null
  return (
    <p className="mono text-field text-graphite">
      {[
        `attempt ${String(run.attempt)}`,
        run.durationMs === null
          ? null
          : `took ${formatDurationMs(run.durationMs)}`,
        `${formatSince(run.sinceMs)} ago`,
      ]
        .filter(Boolean)
        .join(' · ')}
    </p>
  )
}

/**
 * Extraction finishes on the worker, out of band, so nothing would otherwise
 * tell this page it happened. Poll while anything is pending, and stop —
 * `failed` is terminal, and an infinite poll on a broken worker is worse
 * than a stale row.
 */
function useExtractionPolling(
  documents: Documents,
  router: ReturnType<typeof useRouter>,
) {
  const waiting = documents.some((d) => d.extractionStatus === 'pending')
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    if (!waiting) {
      setAttempts(0)
      return
    }
    if (attempts >= 10) return
    const timer = setTimeout(() => {
      setAttempts((n) => n + 1)
      void router.invalidate()
    }, 2500)
    return () => clearTimeout(timer)
  }, [waiting, attempts, router])
}

// ---------- upload ----------

async function uploadOne(
  file: File,
  entityId: string,
  setPhase: (phase: Pending['phase']) => void,
): Promise<void> {
  if (file.size === 0) throw new Error('File is empty')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`)
  }

  setPhase('hashing')
  const sha = await sha256Hex(file)

  const { uploadUrl, uploadHeaders } = await prepareDocumentUpload({
    data: { sha, sizeBytes: file.size },
  })

  if (uploadUrl) {
    setPhase('uploading')
    // uploadHeaders carry the S3 checksum condition when that driver is
    // live — the signature breaks without them. Empty for local.
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: uploadHeaders,
    })
    if (!response.ok) {
      throw new Error((await response.text()) || 'Storage rejected the upload')
    }
  }

  setPhase('filing')
  await finalizeDocumentUpload({
    data: {
      sha,
      filename: file.name,
      mime: file.type || null,
      sizeBytes: file.size,
      kind: guessDocumentKind(file.name),
      // The Files tab is a record surface: every one of its four routes
      // (company, person, deal, custom record) files through
      // `link(tagged_in)`. A space files the other way and has no Files tab
      // yet — that surface is docsurf-1b's.
      fileAgainst: { kind: 'record', entityId },
    },
  })
}

/**
 * Keys are content addresses, so the browser has to compute one before it
 * can be handed an upload URL. crypto.subtle only exists in a secure
 * context — which the app already requires for its own Secure cookies, so
 * say that plainly instead of failing with "undefined is not a function".
 */
async function sha256Hex(file: File): Promise<string> {
  // The DOM types promise crypto.subtle unconditionally; an insecure context
  // does not, and that's exactly the case worth reporting well.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'Uploads need a secure context — serve the app over HTTPS or on localhost',
    )
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
