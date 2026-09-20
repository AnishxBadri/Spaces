import { useRouter } from '@tanstack/react-router'
import { Download, Eye, FileText, Loader2, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LedgerFigure, LedgerRow, LedgerSection } from './ledger-section'
import { Button } from './ui/button'
import { useConfirm } from './ui/confirm-dialog'
import { DocumentPreview } from './document-preview'
import {
  DOCUMENT_KIND_LABELS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  guessDocumentKind,
} from '@spaces/core/documents'
import { formatSince } from '@spaces/core/format'
import type { SpaceSource } from '#/lib/documents/space-sources'
import {
  deleteDocument,
  finalizeDocumentUpload,
  getDocumentDownloadUrl,
  prepareDocumentUpload,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Sources — the documents filed **into** a space (spec-storage-sources §3.2,
 * entry point 2). A space page is a ledger, so this is the page's own
 * vocabulary — `LedgerSection` / `LedgerRow` / `LedgerFigure`, exactly as
 * "Filed here" and "Companies" are — and not `RecordFiles`, which is a Files
 * *tab* with its own upload strip and three-letter tile.
 *
 * What is shared is the upload path, which is the same four steps the Files
 * tab takes: hash in the browser, ask for a URL, PUT straight at storage,
 * then file the row — with `fileAgainst: {kind:'space'}`, so the edge is
 * `entity_space` and never `link(tagged_in)` (SPA-19). `uploadToSpace` and
 * `sha256Hex` below deliberately mirror `record-files.tsx` line for line;
 * SPA-71 hoists both into one module, and until it does, two readable copies
 * beat one premature abstraction.
 */

/** In-flight uploads, shown above the filed rows. */
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

export function SpaceSources({
  spaceId,
  spaceName,
  sources,
}: {
  spaceId: string
  spaceName: string
  sources: Array<SpaceSource>
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState<Array<Pending>>([])
  const [previewing, setPreviewing] = useState<SpaceSource | null>(null)

  useExtractionPolling(sources, router)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      const key = `${file.name}-${String(file.size)}-${String(pending.length)}-${String(Math.random())}`
      setPending((p) => [...p, { key, name: file.name, phase: 'hashing' }])
      const setPhase = (phase: Pending['phase']) =>
        setPending((p) => p.map((x) => (x.key === key ? { ...x, phase } : x)))
      try {
        await uploadToSpace(file, spaceId, setPhase)
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

  const bytes = sources.reduce((n, s) => n + (s.sizeBytes ?? 0), 0)

  return (
    /* The whole section is the drop target — a space is filed *into*, so the
       gesture is "drop it here", not "find the upload button". */
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
      /* Drag feedback is the selection wash and nothing else: 1-bit, no
         layout shift, and no sentence in the mono count lane — that lane is
         the instrument measuring itself, not a line for a person to read. */
      className={cn(
        'flex flex-col transition-colors',
        dragging && 'bg-selected',
      )}
    >
      <LedgerSection
        label="Sources"
        count={
          sources.length === 0
            ? '0 sources'
            : `${sources.length} source${sources.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`
        }
        link={
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="focus-ring flex items-center gap-1 text-primary hover:underline"
          >
            <Upload className="size-3" strokeWidth={2} />
            upload
          </button>
        }
      >
        {pending.map((p) => (
          <LedgerRow key={p.key}>
            <span className="w-3.5 shrink-0 text-center">
              {p.error ? (
                <FileText
                  className="size-3.5 text-destructive"
                  strokeWidth={1.75}
                />
              ) : (
                <Loader2
                  className="size-3.5 animate-spin text-graphite motion-reduce:animate-none"
                  strokeWidth={1.75}
                />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-graphite">
              {p.name}
            </span>
            <LedgerFigure tone={p.error ? 'bad' : 'muted'} wide>
              {p.error ?? PHASE_LABELS[p.phase]}
            </LedgerFigure>
          </LedgerRow>
        ))}

        {sources.map((s) => (
          <SourceRow
            key={s.id}
            source={s}
            spaceName={spaceName}
            onPreview={() => setPreviewing(s)}
          />
        ))}

        {/* Empty is a row that says what belongs here, never an empty grid. */}
        {sources.length === 0 && pending.length === 0 ? (
          <LedgerRow last>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:bg-bone"
            >
              <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
                +
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-graphite">
                No sources yet — drop a deck, a report or an article to file it
                into this space.
              </span>
            </button>
          </LedgerRow>
        ) : null}
      </LedgerSection>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label={`Upload a source into ${spaceName}`}
        onChange={(e) => {
          void handleFiles(e.target.files)
          e.target.value = ''
        }}
      />

      <DocumentPreview
        doc={previewing}
        onOpenChange={(open) => !open && setPreviewing(null)}
      />
    </div>
  )
}

/**
 * One source. Two lines inside the row, as "Filed here" is two lines: the
 * filename a person reads, then what the instrument knows about it — the
 * kind, then the snippet or whatever extraction has to say. The row ends on
 * the fixed mono lane every ledger row ends on, carrying the size.
 */
function SourceRow({
  source,
  spaceName,
  onPreview,
}: {
  source: SpaceSource
  spaceName: string
  onPreview: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function download() {
    try {
      const { url } = await getDocumentDownloadUrl({ data: { id: source.id } })
      window.location.href = url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download')
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete ${source.filename}?`,
      body: `It leaves ${spaceName} and the server. This cannot be undone.`,
      action: 'Delete',
    })
    if (!ok) return
    setBusy(true)
    try {
      await deleteDocument({ data: { id: source.id } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <li className="group flex items-center gap-3 border-b border-rule py-2.5">
      <FileText
        className="size-3.5 shrink-0 text-graphite"
        strokeWidth={1.75}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          onClick={onPreview}
          title={`Preview ${source.filename}`}
          className="focus-ring min-w-0 truncate text-left text-ui font-medium hover:underline"
        >
          {source.filename}
        </button>
        <SourceNote source={source} />
        <span className="truncate mono text-field text-graphite">
          {[source.uploadedByName, `${formatSince(source.sinceMs)} ago`]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Preview ${source.filename}`}
          onClick={onPreview}
          className="text-graphite opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Eye />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Download ${source.filename}`}
          onClick={download}
          className="text-graphite"
        >
          <Download />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          aria-label={`Delete ${source.filename}`}
          onClick={remove}
          className="text-graphite opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
        >
          <Trash2 />
        </Button>
      </div>
      <LedgerFigure tone="muted">{formatBytes(source.sizeBytes)}</LedgerFigure>
      {confirmDialog}
    </li>
  )
}

/**
 * The instrument's line about the file: the kind always, then the snippet
 * once there is one — or, before there is, what extraction is doing.
 * "Extracting", "no text layer" and "extraction broke" are three different
 * facts and only the last is a problem.
 */
function SourceNote({ source }: { source: SpaceSource }) {
  const kind = DOCUMENT_KIND_LABELS[source.kind].toLowerCase()
  if (source.extractionStatus === 'pending') {
    return (
      <p className="truncate mono text-field text-graphite">
        {kind} · extracting text…
      </p>
    )
  }
  if (source.extractionStatus === 'failed') {
    return (
      <p className="truncate mono text-field text-destructive">
        {kind} · text extraction failed — {source.extractionError}
      </p>
    )
  }
  if (source.extractionStatus === 'unsupported') {
    return (
      <p className="truncate mono text-field text-graphite">
        {kind} · {source.extractionError ?? 'no extractable text'}
      </p>
    )
  }
  return (
    <p className="truncate text-label text-graphite">
      <span className="mono text-field">{kind}</span>
      {source.snippet ? ` · ${source.snippet}` : ''}
    </p>
  )
}

/**
 * Extraction finishes on the worker, out of band, so nothing would otherwise
 * tell this page it happened. Poll while anything is pending, and stop —
 * `failed` is terminal, and an infinite poll on a broken worker is worse
 * than a stale row. Same shape, same ceiling as the Files tab's.
 */
function useExtractionPolling(
  sources: Array<SpaceSource>,
  router: ReturnType<typeof useRouter>,
) {
  const waiting = sources.some((s) => s.extractionStatus === 'pending')
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

/**
 * The Files tab's `uploadOne`, with `fileAgainst: {kind:'space'}`. Kept a
 * copy on purpose: SPA-71 hoists this and `record-files.tsx`'s twin into one
 * module, and doing it here would mean editing a file two other slices are
 * open in.
 */
async function uploadToSpace(
  file: File,
  spaceId: string,
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
      // The one line that differs from the Files tab: a space is filed
      // *into*, through `entity_space`, so the target says `space` and the
      // writer picks the other edge table (SPA-19).
      fileAgainst: { kind: 'space', entityId: spaceId },
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
