import { useRouter } from '@tanstack/react-router'
import {
  Download,
  Eye,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Loader2,
  Presentation,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { DocumentPreview } from './document-preview'
import {
  DOCUMENT_KIND_LABELS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  guessDocumentKind,
} from '#/lib/documents'
import {
  deleteDocument,
  finalizeDocumentUpload,
  getDocumentDownloadUrl,
  prepareDocumentUpload,
} from '#/lib/server-fns'
import type { listRecordDocuments } from '#/lib/server-fns'
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

const dateFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const KIND_ICONS: Record<string, typeof FileIcon> = {
  deck: Presentation,
  cap_table: FileSpreadsheet,
  memo: FileText,
  dd: FileText,
  legal: FileText,
  article: FileText,
}

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
        router.invalidate()
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
        handleFiles(e.dataTransfer.files)
      }}
      className={cn(
        'mt-4 rounded-md transition-colors',
        // Flat at rest: the ring only appears because the user is dragging.
        dragging && 'ring-2 ring-ring/60 ring-offset-2 ring-offset-background',
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {documents.length === 0
            ? 'Decks, memos, cap tables — drop them here.'
            : `${documents.length} file${documents.length === 1 ? '' : 's'}`}
        </p>
        <Button
          size="xs"
          variant="outline"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="size-3" strokeWidth={2} />
          Upload
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {documents.length === 0 && pending.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-border px-4 py-8 text-center">
          <p className="text-[13px] text-muted-foreground">
            No files yet. Drag one in, or use Upload.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/80">
            PDF, DOCX, PPTX and XLSX get their text extracted and searched.
          </p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {pending.map((p) => (
            <li
              key={p.key}
              className="flex items-center gap-3 px-1 py-2.5 text-[13px]"
            >
              {p.error ? (
                <FileIcon
                  className="size-4 text-destructive"
                  strokeWidth={1.75}
                />
              ) : (
                <Loader2
                  className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                  strokeWidth={1.75}
                />
              )}
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span
                className={cn(
                  'text-xs',
                  p.error ? 'text-destructive' : 'text-muted-foreground',
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
      )}

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
  const Icon = KIND_ICONS[doc.kind] ?? FileIcon

  async function download() {
    try {
      const { url } = await getDocumentDownloadUrl({ data: { id: doc.id } })
      window.location.href = url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download')
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${doc.filename}? This cannot be undone.`))
      return
    setBusy(true)
    try {
      await deleteDocument({ data: { id: doc.id } })
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <li className="group flex items-start gap-3 px-1 py-2.5 text-[13px]">
      <Icon
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        strokeWidth={1.75}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPreview}
            title={`Preview ${doc.filename}`}
            className="focus-ring min-w-0 truncate rounded text-left font-medium hover:underline"
          >
            {doc.filename}
          </button>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {DOCUMENT_KIND_LABELS[doc.kind]}
          </span>
        </div>
        <p className="tabular mt-0.5 text-xs text-muted-foreground/80">
          {[
            formatBytes(doc.sizeBytes),
            doc.uploadedByName,
            dateFmt.format(new Date(doc.createdAt)),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <ExtractionNote doc={doc} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Preview ${doc.filename}`}
          onClick={onPreview}
        >
          <Eye />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Download ${doc.filename}`}
          onClick={download}
        >
          <Download />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          aria-label={`Delete ${doc.filename}`}
          onClick={remove}
          className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  )
}

/**
 * "Extracting", "no text layer", and "extraction broke" are three different
 * facts, and only the last one is a problem — a scanned deck is a normal
 * document, not a failure.
 */
function ExtractionNote({ doc }: { doc: Documents[number] }) {
  if (doc.extractionStatus === 'pending') {
    return (
      <p className="mt-1 text-xs text-muted-foreground/80">Extracting text…</p>
    )
  }
  if (doc.extractionStatus === 'failed') {
    return (
      <p className="mt-1 text-xs text-destructive">
        Text extraction failed — {doc.extractionError}
      </p>
    )
  }
  if (doc.extractionStatus === 'unsupported') {
    return (
      <p className="mt-1 text-xs text-muted-foreground/80">
        {doc.extractionError ?? 'No extractable text'}
      </p>
    )
  }
  if (doc.snippet) {
    return (
      <p className="mt-1 truncate text-xs text-muted-foreground/80">
        {doc.snippet}
      </p>
    )
  }
  return null
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
      router.invalidate()
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
      attachTo: entityId,
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
