import { useRouter } from '@tanstack/react-router'
import {
  Download,
  Eye,
  File as FileIcon,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { useConfirm } from './ui/confirm-dialog'
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
        <span className="mono text-[0.625rem] leading-3 text-graphite">
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
      <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper mono text-[0.5rem] leading-[0.625rem] text-foreground">
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
        <span className="truncate mono text-[0.625rem] leading-3 text-graphite">
          {[
            DOCUMENT_KIND_LABELS[doc.kind].toLowerCase(),
            formatBytes(doc.sizeBytes),
            doc.createdAt.slice(5, 10),
            doc.uploadedByName,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <ExtractionNote doc={doc} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
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
 */
function ExtractionNote({ doc }: { doc: Documents[number] }) {
  if (doc.extractionStatus === 'pending') {
    return (
      <p className="mono text-[0.625rem] leading-3 text-graphite">
        extracting text…
      </p>
    )
  }
  if (doc.extractionStatus === 'failed') {
    return (
      <p className="mono text-[0.625rem] leading-3 text-destructive">
        text extraction failed — {doc.extractionError}
      </p>
    )
  }
  if (doc.extractionStatus === 'unsupported') {
    return (
      <p className="mono text-[0.625rem] leading-3 text-graphite">
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
