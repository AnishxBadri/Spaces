import { Download, ExternalLink, FileWarning, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PDFDocumentProxy } from 'unpdf/pdfjs'
import { Button } from './ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { FileGlyph } from './files/file-glyph'
import { detectFormat } from '@spaces/core/documents/extract'
import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import { getDocumentDownloadUrl, getDocumentText } from '#/lib/server-fns'
import { fileType } from '#/lib/documents/files-tab'
import { cn } from '#/lib/utils'

/**
 * The file viewer: a window over the page, looking at a document without
 * downloading it. A window rather than a route, so Back undoes reading
 * position and not the look. (D66)
 * - Title bar: glyph, name, `deck · 4.1 MB · 14 pages`, `Replaced by → …`
 *   on an older version, a PDF's page nav and zoom, Download. It closes from its foot (the close-mark rule).
 * - A caller may pass a `sidebar` (the Files tab's KIND, FILED ON, …) and
 *   `foot` actions beside Cancel.
 *
 * **Nothing here relaxes the download hardening.** Blobs are served as
 * `application/octet-stream; attachment`, because an uploaded `.html` served
 * inline from this origin is stored XSS. The viewer fetches those opaque
 * bytes and renders them itself: a PDF through pdf.js to a canvas, an image
 * through an object URL whose type we choose, office files from the
 * extracted text. SVG never renders inline: it is a script vector.
 *
 * A row with no blob (a clipped article) has no bytes: its text is shown
 * with the address linked, and Download becomes Open source, because
 * `getDocumentDownloadUrl` throws for a null `blob_sha` and should.
 */

type Doc = {
  id: string
  filename: string
  mime: string | null
  sizeBytes: number | null
  /** The genre, printed first in the title bar's mono line when known. */
  kind?: DocumentKind | undefined
  extractionStatus: string
  extractionError: string | null
  /** Null when there are no bytes to fetch — a clipped article. */
  blobSha: string | null
  /** The page a clip was read from, and null on every row that had bytes. */
  url: string | null
  /** The newer version that supersedes this file; the head says so. (D59) */
  replacedBy?: { id: string; name: string } | null
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
  // Attachments are labelled `application/octet-stream` constantly, so fall
  // back to the extension, as the extractor's detectFormat does.
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
  page,
  onOpenChange,
  sidebar = null,
  foot = null,
}: {
  doc: Doc | null
  /** The 1-based page a PDF opens at; the first when omitted. */
  page?: number
  onOpenChange: (open: boolean) => void
  /** The column right of the page. */
  sidebar?: ReactNode
  /** Foot actions, left of Cancel. */
  foot?: ReactNode
}) {
  return (
    <Dialog open={Boolean(doc)} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex h-[85vh] flex-col gap-0 overflow-hidden p-0',
          sidebar === null
            ? 'max-w-4xl sm:max-w-4xl'
            : 'max-w-6xl sm:max-w-6xl',
        )}
      >
        {doc ? (
          <PreviewBody
            doc={doc}
            startPage={page ?? 1}
            sidebar={sidebar}
            foot={foot}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** A PDF's zoom: fitted to the page column, or a scale the reader chose. */
type Zoom = 'fit' | number

function PreviewBody({
  doc,
  startPage,
  sidebar,
  foot,
}: {
  doc: Doc
  startPage: number
  sidebar: ReactNode
  foot: ReactNode
}) {
  const format = detectFormat(doc.filename, doc.mime)
  const asImage = imageType(doc)
  const blobless = doc.blobSha === null
  const isPdf = !blobless && format === 'pdf'
  const [page, setPage] = useState(Math.max(1, startPage))
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [fitScale, setFitScale] = useState(1)
  const scale = zoom === 'fit' ? fitScale : zoom
  const onPages = useCallback((n: number) => {
    setPages(n)
    // A page past the end (the file was replaced) opens on the last.
    setPage((p) => Math.min(p, n))
  }, [])

  async function download() {
    const { url } = await getDocumentDownloadUrl({ data: { id: doc.id } })
    window.location.href = url
  }

  return (
    <>
      {/* The title bar at the sheet's edge: the content is `p-0`, so the
          header's own breakout is cancelled here. */}
      <DialogHeader className="mx-0 mt-0 mb-0 h-12 shrink-0 flex-nowrap items-center gap-3 py-0">
        <FileGlyph
          type={fileType({ ...doc, externalUrl: null })}
          className="-ml-1"
        />
        <DialogTitle
          className={cn(
            'min-w-0 truncate text-title leading-5',
            doc.replacedBy != null && 'text-graphite',
          )}
        >
          {doc.filename}
        </DialogTitle>
        <DialogDescription className="shrink-0">
          {[
            doc.kind === undefined
              ? format
                ? format.toUpperCase()
                : (doc.mime ?? 'Unknown type')
              : DOCUMENT_KIND_LABELS[doc.kind].toLowerCase(),
            doc.sizeBytes ? formatBytes(doc.sizeBytes) : null,
            isPdf && pages > 0
              ? `${String(pages)} page${pages === 1 ? '' : 's'}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </DialogDescription>
        {doc.replacedBy == null ? null : (
          <span className="min-w-0 truncate mono text-micro text-graphite">
            Replaced by → {doc.replacedBy.name}
          </span>
        )}
        <span className="flex-1" />
        {isPdf && pages > 1 ? (
          <div className="flex h-[1.625rem] shrink-0 items-stretch border border-rule bg-paper mono text-micro">
            <button
              type="button"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((n) => Math.max(1, n - 1))}
              className="focus-ring w-6 border-r border-rule hover:bg-bone disabled:text-graphite"
            >
              ‹
            </button>
            <span className="tabular flex items-center px-2">
              {page} / {pages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={page >= pages}
              onClick={() => setPage((n) => Math.min(pages, n + 1))}
              className="focus-ring w-6 border-l border-rule hover:bg-bone disabled:text-graphite"
            >
              ›
            </button>
          </div>
        ) : null}
        {isPdf ? (
          <div className="flex h-[1.625rem] shrink-0 items-stretch border border-rule bg-paper mono text-micro">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => setZoom(Math.max(0.25, scale / 1.25))}
              className="focus-ring w-6 border-r border-rule hover:bg-bone"
            >
              -
            </button>
            <button
              type="button"
              aria-label="Fit to width"
              aria-pressed={zoom === 'fit'}
              onClick={() => setZoom('fit')}
              className="focus-ring px-2 hover:bg-bone"
            >
              fit
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => setZoom(Math.min(4, scale * 1.25))}
              className="focus-ring w-6 border-l border-rule hover:bg-bone"
            >
              +
            </button>
          </div>
        ) : null}
        <div className="flex shrink-0 items-center">
          {blobless ? (
            doc.url === null ? null : (
              <Button size="sm" variant="outline" asChild>
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={doc.url}
                >
                  <ExternalLink className="size-3" strokeWidth={2} />
                  Open source
                </a>
              </Button>
            )
          ) : (
            <Button size="sm" variant="outline" onClick={download}>
              <Download className="size-3" strokeWidth={2} />
              Download
            </Button>
          )}
        </div>
      </DialogHeader>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-bone">
          {blobless ? (
            <TextPreview doc={doc} format={format} />
          ) : isPdf ? (
            <PdfPreview
              doc={doc}
              page={page}
              scale={scale}
              onPages={onPages}
              onPage={setPage}
              onFitScale={setFitScale}
            />
          ) : asImage ? (
            <ImagePreview doc={doc} type={asImage} />
          ) : (
            <TextPreview doc={doc} format={format} />
          )}
        </div>
        {sidebar === null ? null : (
          <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-hairline bg-paper">
            {sidebar}
          </aside>
        )}
      </div>

      {/* The foot, breakout cancelled like the head's. */}
      <DialogFooter className="mx-0 mt-0 mb-0 shrink-0">
        {foot}
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
      </DialogFooter>
    </>
  )
}

/** Shared framing for "there is nothing to show, and here is why". */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <FileWarning className="mb-3 size-5 text-graphite" strokeWidth={1.75} />
        <p className="text-ui text-graphite">{children}</p>
      </div>
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-ui text-graphite">
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

  // A run token: a stale fetch resolving late must not overwrite the next
  // document's state.
  const runRef = useRef(0)

  useEffect(() => {
    const run = ++runRef.current
    setState({ bytes: null, error: null })
    void (async () => {
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

/** The parsed PDF, held across pages so paging never re-parses the file. */
function usePdf(bytes: ArrayBuffer | null) {
  const [state, setState] = useState<{
    pdf: PDFDocumentProxy | null
    error: string | null
  }>({ pdf: null, error: null })

  useEffect(() => {
    if (!bytes) return
    const stale = { current: false }
    void (async () => {
      try {
        // Dynamic: pdf.js is large and only this window needs it.
        const { getDocument } = await import('unpdf/pdfjs')
        const pdf = await getDocument({
          data: new Uint8Array(bytes.slice(0)),
          // unpdf's pdf.js is worker-free: it renders on the main thread,
          // fine for a page at a time, and no worker asset to serve.
          useWorkerFetch: false,
          verbosity: 0,
        }).promise
        if (!stale.current) setState({ pdf, error: null })
      } catch (err) {
        if (!stale.current)
          setState({
            pdf: null,
            error: err instanceof Error ? err.message : String(err),
          })
      }
    })()
    return () => {
      stale.current = true
    }
  }, [bytes])

  return state
}

/** Draws one page to a canvas at a scale, at device resolution. */
async function drawPage(
  pdf: PDFDocumentProxy,
  n: number,
  canvas: HTMLCanvasElement,
  scaleFor: (baseWidth: number) => number,
  onTask: (task: { cancel: () => void }) => void,
): Promise<void> {
  const p = await pdf.getPage(n)
  const base = p.getViewport({ scale: 1 })
  const viewport = p.getViewport({ scale: scaleFor(base.width) })
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const task = p.render({ canvas: null, canvasContext: ctx, viewport })
  onTask(task)
  await task.promise
}

/** Paging cancels the previous render on purpose; that is not a failure. */
const cancelled = (err: unknown) =>
  /cancel/i.test(err instanceof Error ? err.message : String(err))

function PdfPreview({
  doc,
  page,
  scale,
  onPages,
  onPage,
  onFitScale,
}: {
  doc: Doc
  page: number
  scale: number
  onPages: (pages: number) => void
  onPage: (page: number) => void
  onFitScale: (scale: number) => void
}) {
  const { bytes, error } = useBlobBytes(doc.id)
  const { pdf, error: parseError } = usePdf(bytes)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [width, setWidth] = useState(900)

  useEffect(() => {
    if (pdf) onPages(pdf.numPages)
  }, [pdf, onPages])

  // The column's width, so `fit` fits the page to what is there.
  useEffect(() => {
    const el = columnRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!pdf || !canvas) return
    let task: { cancel: () => void } | null = null
    void drawPage(
      pdf,
      Math.min(page, pdf.numPages),
      canvas,
      (base) => {
        const fit = Math.max(0.25, (width - 48) / base)
        onFitScale(fit)
        return scale
      },
      (t) => {
        task = t
      },
    ).catch((err: unknown) => {
      if (!cancelled(err))
        setRenderError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      task?.cancel()
    }
  }, [pdf, page, scale, width, onFitScale])

  if (error) return <Notice>Could not load the file — {error}</Notice>
  const failure = parseError ?? renderError
  if (failure)
    return <Notice>This PDF could not be rendered — {failure}</Notice>

  return (
    <div className="flex h-full">
      {pdf && pdf.numPages > 1 ? (
        <Thumbnails pdf={pdf} page={page} onPage={onPage} />
      ) : null}
      <div ref={columnRef} className="min-w-0 flex-1 overflow-auto p-6">
        {pdf ? null : <Spinner label="Loading PDF…" />}
        <canvas
          ref={canvasRef}
          aria-label={`${doc.filename}, page ${page}`}
          className={cn(
            'mx-auto rounded-none border border-hairline bg-paper',
            !pdf && 'hidden',
          )}
        />
        {pdf ? (
          <p className="mt-3 text-center mono text-micro text-graphite">
            page {page} of {pdf.numPages}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** The thumbnail rail left of the page; each draws once it scrolls into view. */
function Thumbnails({
  pdf,
  page,
  onPage,
}: {
  pdf: PDFDocumentProxy
  page: number
  onPage: (page: number) => void
}) {
  return (
    <ol className="flex w-36 shrink-0 flex-col gap-3 overflow-y-auto border-r border-rule bg-bone py-3 pr-3 pl-2">
      {Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => (
        <li key={n} className="flex items-start gap-1.5">
          <span className="w-4 shrink-0 text-right mono text-micro text-graphite">
            {n}
          </span>
          <Thumb pdf={pdf} n={n} current={n === page} onPick={onPage} />
        </li>
      ))}
    </ol>
  )
}

function Thumb({
  pdf,
  n,
  current,
  onPick,
}: {
  pdf: PDFDocumentProxy
  n: number
  current: boolean
  onPick: (page: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const el = ref.current
    if (seen || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen])

  useEffect(() => {
    const canvas = ref.current
    if (!seen || !canvas) return
    let task: { cancel: () => void } | null = null
    void drawPage(
      pdf,
      n,
      canvas,
      (base) => 96 / base,
      (t) => {
        task = t
      },
    ).catch(() => undefined)
    return () => {
      task?.cancel()
    }
  }, [seen, pdf, n])

  return (
    <button
      type="button"
      aria-label={`Page ${n}`}
      aria-current={current ? 'page' : undefined}
      onClick={() => onPick(n)}
      className={cn(
        'focus-ring border bg-paper p-0.5',
        current ? 'border-foreground' : 'border-rule hover:border-hairline',
      )}
    >
      <canvas ref={ref} className="block h-auto min-h-12 w-24" />
    </button>
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
        className="max-h-full max-w-full rounded-none border border-rule bg-white object-contain"
      />
    </div>
  )
}

/**
 * Office files and plain text render from the worker's extraction — no
 * viewer to ship, and a spreadsheet comes back as its grid because the
 * extractor keeps tabs as column separators. A clipped article's text *is*
 * the document, so its address is printed above it.
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

  const blobless = doc.blobSha === null

  if (doc.extractionStatus === 'pending')
    return (
      <Spinner label={blobless ? 'Fetching the page…' : 'Extracting text…'} />
    )
  if (loading) return <Spinner label="Loading…" />

  if (!text) {
    return (
      <Notice>
        {doc.extractionError ??
          (blobless
            ? 'No text was read from this page — open the source to read it.'
            : 'No preview for this file type — download it to open.')}
      </Notice>
    )
  }

  if (format === 'xlsx') return <SheetPreview text={text} />

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      {blobless && doc.url !== null ? (
        <a
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring mb-4 block truncate mono text-field text-primary hover:underline"
        >
          {doc.url}
        </a>
      ) : null}
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
            <h3 className="mb-1.5 text-label font-medium text-graphite">
              {sheet.title}
            </h3>
          ) : null}
          <div className="overflow-x-auto rounded-md border border-rule bg-paper">
            <table className="w-full border-collapse text-ui">
              <tbody>
                {sheet.rows.map((row, r) => (
                  <tr key={r} className="border-b border-rule last:border-b-0">
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className={cn(
                          'border-r border-rule px-2 py-1 last:border-r-0',
                          // A leading header row is the near-universal shape
                          // of an exported sheet.
                          r === 0 && 'bg-bone font-medium',
                          // Numbers align as numbers inside a preview too.
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
