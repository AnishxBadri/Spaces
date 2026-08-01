import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileWarning,
  Loader2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { detectFormat } from '#/lib/documents/extract'
import { formatBytes } from '#/lib/documents'
import { getDocumentDownloadUrl, getDocumentText } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Look at a document without downloading it.
 *
 * A modal is normally the lazy answer, and DESIGN.md says to argue for one.
 * The argument: a preview is an *inspection*, not a destination — you open it,
 * look, and come back to the record you were reading. Giving it a route would
 * make the back button undo your reading position instead of the preview.
 *
 * **Nothing here relaxes the download hardening.** Blobs are still served as
 * `application/octet-stream; attachment`, because an uploaded `.html` served
 * inline from this origin is stored XSS against the app. The preview fetches
 * those same opaque bytes and renders them itself:
 *
 *   PDF    pdf.js to a canvas, so the browser never navigates to the file
 *   image  an object URL whose type *we* choose, never the stored mime
 *   office the text the worker already extracted — free, and a tab-separated
 *          spreadsheet renders back into a grid
 *
 * The one format that must never render inline is SVG: it is a script vector,
 * and `<img>` is the only safe element for it, so it stays download-only.
 */

type Doc = {
  id: string
  filename: string
  mime: string | null
  sizeBytes: number | null
  extractionStatus: string
  extractionError: string | null
}

/** Raster types only — SVG can carry script and is deliberately absent. */
const PREVIEWABLE_IMAGES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
])

function imageType(doc: Doc): string | null {
  const mime = doc.mime?.toLowerCase().split(';')[0].trim()
  if (mime && PREVIEWABLE_IMAGES.has(mime)) return mime
  // Browsers and mail clients label attachments `application/octet-stream`
  // constantly, so fall back to the extension — same reasoning as the
  // extractor's detectFormat.
  const ext = doc.filename.toLowerCase().split('.').pop()
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
  }
  return ext ? (byExt[ext] ?? null) : null
}

export function DocumentPreview({
  doc,
  onOpenChange,
}: {
  doc: Doc | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={Boolean(doc)} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {doc ? <PreviewBody doc={doc} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PreviewBody({ doc }: { doc: Doc }) {
  const format = detectFormat(doc.filename, doc.mime)
  const asImage = imageType(doc)

  async function download() {
    const { url } = await getDocumentDownloadUrl({ data: { id: doc.id } })
    window.location.href = url
  }

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-border py-3 pr-12 pl-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-title">
              {doc.filename}
            </DialogTitle>
            <DialogDescription className="text-label">
              {[
                format ? format.toUpperCase() : (doc.mime ?? 'Unknown type'),
                doc.sizeBytes ? formatBytes(doc.sizeBytes) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </DialogDescription>
          </div>
          <Button size="xs" variant="outline" onClick={download}>
            <Download className="size-3" strokeWidth={2} />
            Download
          </Button>
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-auto bg-muted/40">
        {format === 'pdf' ? (
          <PdfPreview doc={doc} />
        ) : asImage ? (
          <ImagePreview doc={doc} type={asImage} />
        ) : (
          <TextPreview doc={doc} format={format} />
        )}
      </div>
    </>
  )
}

/** Shared framing for "there is nothing to show, and here is why". */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <FileWarning
          className="mb-3 size-5 text-muted-foreground"
          strokeWidth={1.75}
        />
        <p className="text-ui text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-ui text-muted-foreground">
      <Loader2
        className="size-4 animate-spin motion-reduce:animate-none"
        strokeWidth={1.75}
      />
      {label}
    </div>
  )
}

/** Fetches the blob through the signed URL — always as opaque bytes. */
function useBlobBytes(id: string) {
  const [state, setState] = useState<{
    bytes: ArrayBuffer | null
    error: string | null
  }>({ bytes: null, error: null })

  // A run token rather than a boolean: the effect re-runs when the previewed
  // document changes, and a stale fetch resolving late must not overwrite the
  // new one's state.
  const runRef = useRef(0)

  useEffect(() => {
    const run = ++runRef.current
    setState({ bytes: null, error: null })
    ;(async () => {
      try {
        const { url } = await getDocumentDownloadUrl({ data: { id } })
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Storage returned ${res.status}`)
        const bytes = await res.arrayBuffer()
        if (runRef.current === run) setState({ bytes, error: null })
      } catch (err) {
        if (runRef.current === run)
          setState({
            bytes: null,
            error: err instanceof Error ? err.message : 'Could not load file',
          })
      }
    })()
  }, [id])

  return state
}

function PdfPreview({ doc }: { doc: Doc }) {
  const { bytes, error } = useBlobBytes(doc.id)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [renderError, setRenderError] = useState<string | null>(null)
  // Held across renders so paging doesn't re-parse the whole file.
  const pdfRef = useRef<{ numPages: number; getPage: (n: number) => never }>(
    null,
  )

  const runRef = useRef(0)

  useEffect(() => {
    if (!bytes) return
    const run = ++runRef.current
    let cancelled: { cancel: () => void } | null = null
    ;(async () => {
      try {
        // Dynamic: pdf.js is large and only this dialog needs it.
        const { getDocument } = await import('unpdf/pdfjs')
        if (!pdfRef.current) {
          const task = getDocument({
            data: new Uint8Array(bytes.slice(0)),
            // unpdf ships a worker-free pdf.js build, so this renders on the
            // main thread — fine for one page at a time, and it means no
            // worker asset to serve from a self-hosted container.
            useWorkerFetch: false,
            verbosity: 0,
          })
          const pdf = await task.promise
          if (runRef.current !== run) return
          pdfRef.current = pdf as never
          setPages(pdf.numPages)
        }
        const pdf = pdfRef.current as unknown as {
          getPage: (n: number) => Promise<never>
        }
        const p = (await pdf.getPage(page)) as unknown as {
          getViewport: (o: { scale: number }) => {
            width: number
            height: number
          }
          render: (o: object) => { promise: Promise<void>; cancel: () => void }
        }
        const canvas = canvasRef.current
        if (!canvas || runRef.current !== run) return
        const base = p.getViewport({ scale: 1 })
        // Fit the dialog width, then draw at device resolution so text on a
        // deck stays legible rather than resampled.
        const scale = Math.min(2, Math.max(1, 900 / base.width))
        const viewport = p.getViewport({ scale })
        const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const task = p.render({ canvasContext: ctx, viewport })
        cancelled = task
        await task.promise
      } catch (err) {
        if (runRef.current !== run) return
        const message = err instanceof Error ? err.message : String(err)
        // Paging cancels the previous render on purpose; not a failure.
        if (!/cancel/i.test(message)) setRenderError(message)
      }
    })()
    return () => {
      cancelled?.cancel()
    }
  }, [bytes, page])

  if (error) return <Notice>Could not load the file — {error}</Notice>
  if (renderError)
    return <Notice>This PDF could not be rendered — {renderError}</Notice>
  if (!bytes) return <Spinner label="Loading PDF…" />

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <canvas
          ref={canvasRef}
          aria-label={`${doc.filename}, page ${page}`}
          className="mx-auto rounded-sm border border-border bg-white shadow-sm"
        />
      </div>
      {pages > 1 ? (
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border bg-background px-4 py-2">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((n) => Math.max(1, n - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular text-label text-muted-foreground">
            Page {page} of {pages}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next page"
            disabled={page >= pages}
            onClick={() => setPage((n) => Math.min(pages, n + 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ImagePreview({ doc, type }: { doc: Doc; type: string }) {
  const { bytes, error } = useBlobBytes(doc.id)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) return
    // The type is ours, not the upload's — that is the whole safety property.
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [bytes, type])

  if (error) return <Notice>Could not load the file — {error}</Notice>
  if (!url) return <Spinner label="Loading image…" />

  return (
    <div className="flex h-full items-center justify-center p-4">
      <img
        src={url}
        alt={doc.filename}
        className="max-h-full max-w-full rounded-sm border border-border bg-white object-contain"
      />
    </div>
  )
}

/**
 * Office files and plain text render from the worker's extraction rather than
 * the original bytes — no viewer to ship, and a spreadsheet comes back as the
 * grid it was, because the extractor keeps tabs as column separators.
 */
function TextPreview({
  doc,
  format,
}: {
  doc: Doc
  format: ReturnType<typeof detectFormat>
}) {
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const runRef = useRef(0)

  useEffect(() => {
    const run = ++runRef.current
    setLoading(true)
    getDocumentText({ data: { id: doc.id } })
      .then((r) => runRef.current === run && setText(r.text))
      .catch(() => runRef.current === run && setText(null))
      .finally(() => runRef.current === run && setLoading(false))
  }, [doc.id])

  if (doc.extractionStatus === 'pending')
    return <Spinner label="Extracting text…" />
  if (loading) return <Spinner label="Loading…" />

  if (!text) {
    return (
      <Notice>
        {doc.extractionError ??
          'No preview for this file type — download it to open.'}
      </Notice>
    )
  }

  if (format === 'xlsx') return <SheetPreview text={text} />

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <pre className="text-ui leading-relaxed whitespace-pre-wrap text-foreground">
        {text}
      </pre>
    </div>
  )
}

/** `[Sheet]\n` blocks of tab-separated rows, back into tables. */
function SheetPreview({ text }: { text: string }) {
  const sheets = text
    .split(/\n\n(?=\[)/)
    .map((block) => {
      const [head, ...rest] = block.split('\n')
      const titled = /^\[(.*)\]$/.exec(head)
      return {
        title: titled ? titled[1] : null,
        rows: (titled ? rest : block.split('\n')).map((r) => r.split('\t')),
      }
    })
    .filter((s) => s.rows.length > 0)

  return (
    <div className="space-y-6 p-4">
      {sheets.map((sheet, i) => (
        <section key={i}>
          {sheet.title ? (
            <h3 className="mb-1.5 text-label font-medium text-muted-foreground">
              {sheet.title}
            </h3>
          ) : null}
          <div className="overflow-x-auto rounded-md border border-border bg-background">
            <table className="w-full border-collapse text-ui">
              <tbody>
                {sheet.rows.map((row, r) => (
                  <tr
                    key={r}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className={cn(
                          'border-r border-border/40 px-2 py-1 last:border-r-0',
                          // A leading header row is the near-universal shape
                          // of an exported sheet.
                          r === 0 && 'bg-muted/50 font-medium',
                          // Numbers align as numbers — the Tabular Rule holds
                          // inside a preview too.
                          /^[-+]?[\d,.]+%?$/.test(cell.trim()) &&
                            cell.trim() !== '' &&
                            'numeric',
                        )}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
