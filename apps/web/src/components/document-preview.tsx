import { FileWarning } from 'lucide-react'
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
import { followWord } from './files/revision-ledger'
import type { RecordDocument } from './files/types'
import { Twinkle } from './twinkle'
import { detectFormat } from '@spaces/core/documents/extract'
import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import { getDocumentBytes, getDocumentText } from '#/lib/server-fns'
import { addMention, openAsk } from '#/lib/ask/dock-store'
import { useAskSubject } from '#/lib/ask/page-scope'
import type { AskScopeChip } from '#/lib/ask/types'
import { fileType } from '#/lib/documents/files-tab'
import type { FileType } from '#/lib/documents/files-tab'
import { storageLinkProvider } from '#/lib/documents/storage-link'
import { cn } from '#/lib/utils'

/**
 * The file viewer: a window over the page rather than a route, so Back
 * undoes reading position and not the look. Closes from its foot.
 *
 * **Nothing here relaxes the download hardening.** Blobs are served as
 * `application/octet-stream; attachment` (an uploaded `.html` served inline
 * is stored XSS); the viewer renders the opaque bytes itself — pdf.js to a
 * canvas, images through an object URL whose type we choose, office files
 * from extracted text. SVG never renders inline: it is a script vector.
 *
 * - No blob (a clipped article): text with the address linked, and Open
 *   source for Download — `getDocumentDownloadUrl` throws for a null
 *   `blob_sha`, and should.
 * - `remote` (text-only binding): `getDocumentBytes` fetches through the
 *   connection; a connection in error is said in the page, never blank.
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
  /** The newer version that supersedes this file; the head says so. */
  replacedBy?: { id: string; name: string } | null
  /** A followed file's binding: the head reads its provider and revision. */
  follow?: RecordDocument['follow'] | undefined
  externalUrl?: string | null | undefined
  externalStatus?: RecordDocument['externalStatus'] | undefined
}

const FOLLOWED_TYPE_WORD: Partial<Record<FileType, string>> = {
  'google-sheet': 'Sheet',
  xls: 'Sheet',
  'google-doc': 'Doc',
  doc: 'Doc',
  'google-slides': 'Slides',
  ppt: 'Slides',
  pdf: 'PDF',
}

/**
 * The head's mono line: `Deck · 4.2 MB · 14 pages`, or for a followed file
 * `Sheet · Drive · rev 4 · following`.
 */
export function viewerHeadLine(
  doc: Doc,
  format: string | null,
  pages: number,
): string {
  const kind =
    doc.kind === undefined
      ? format
        ? format.toUpperCase()
        : (doc.mime ?? 'Unknown type')
      : DOCUMENT_KIND_LABELS[doc.kind]
  const follow = doc.follow ?? null
  if (follow !== null) {
    const where =
      doc.externalUrl == null
        ? null
        : (storageLinkProvider(doc.externalUrl)?.label ?? null)
    // A followed file is the provider's live file: it is named by what it is.
    const type = fileType({ ...doc, externalUrl: doc.externalUrl ?? null })
    return [
      FOLLOWED_TYPE_WORD[type] ?? kind,
      where,
      `rev ${String(follow.revisions)}`,
      followWord({ follow, externalStatus: doc.externalStatus ?? null }),
    ]
      .filter((part) => part !== null)
      .join(' · ')
  }
  return [
    kind,
    doc.sizeBytes ? formatBytes(doc.sizeBytes) : null,
    pages > 0 ? `${String(pages)} page${pages === 1 ? '' : 's'}` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** A file as Ask's scope chip: its chunks seed the turn. */
const fileChip = (doc: Doc): AskScopeChip => ({
  kind: 'file',
  id: doc.id,
  name: doc.filename,
  href: null,
})

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
  // An open file is Ask's default chip while it is on screen.
  useAskSubject(doc === null ? null : fileChip(doc))
  return (
    <Dialog open={Boolean(doc)} onOpenChange={onOpenChange}>
      <DialogContent size="viewer" className="gap-0 overflow-hidden">
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

  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  async function download() {
    setDownloading(true)
    setDownloadError(null)
    try {
      const answer = await bytesUrl(
        doc.id,
        () => true,
        () => undefined,
      )
      if ('url' in answer) window.location.href = answer.url
      else setDownloadError(answer.unavailable)
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'Could not load file',
      )
    } finally {
      setDownloading(false)
    }
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
        <DialogDescription data-viewer-head className="shrink-0">
          {viewerHeadLine(doc, format, isPdf ? pages : 0)}
        </DialogDescription>
        {doc.replacedBy == null ? null : (
          <span className="min-w-0 truncate mono text-micro text-graphite">
            Replaced by → {doc.replacedBy.name}
          </span>
        )}
        {downloadError === null ? null : (
          <span
            role="alert"
            title={downloadError}
            className="min-w-0 truncate mono text-micro text-graphite"
          >
            {downloadError}
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
                  Open source
                </a>
              </Button>
            )
          ) : (
            <Button
              size="sm"
              variant="outline"
              pending={downloading}
              disabled={downloading}
              onClick={() => void download()}
            >
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
        <DialogClose asChild>
          <Button
            variant="ghost"
            className="mr-auto"
            title="Ask with this file as the scope"
            onClick={() => {
              addMention(fileChip(doc))
              openAsk()
            }}
          >
            Ask about this
          </Button>
        </DialogClose>
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

/** The pane while the file is on its way: the Twinkle over one line. */
function Working({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ui text-graphite">
      <Twinkle size={29} />
      {label}
    </div>
  )
}

const BYTES_POLL_MS = 1500
/** About two minutes of asking before the page says the fetch did not come. */
const BYTES_POLLS = 80

/**
 * A signed URL for the bytes, asking again while the worker fetches a
 * `remote` file from its provider; `unavailable` is the sentence why not.
 */
async function bytesUrl(
  id: string,
  current: () => boolean,
  onFetching: (from: string) => void,
): Promise<{ url: string } | { unavailable: string }> {
  let answer = await getDocumentBytes({ data: { id, poll: false } })
  for (let n = 0; answer.state === 'fetching'; n++) {
    if (n >= BYTES_POLLS)
      return { unavailable: `${answer.from} did not send the file in time` }
    onFetching(answer.from)
    await new Promise((resolve) => setTimeout(resolve, BYTES_POLL_MS))
    if (!current()) return { unavailable: '' }
    answer = await getDocumentBytes({ data: { id, poll: true } })
  }
  return answer.state === 'ready'
    ? { url: answer.url }
    : { unavailable: answer.reason }
}

type BlobState = {
  bytes: ArrayBuffer | null
  error: string | null
  /** Why the file cannot be shown at all: its provider is unreachable. */
  unavailable: string | null
  /** The provider a `remote` file is being fetched from, while it is. */
  fetchingFrom: string | null
}

const NO_BYTES: BlobState = {
  bytes: null,
  error: null,
  unavailable: null,
  fetchingFrom: null,
}

/** Fetches the blob through the signed URL — always as opaque bytes. */
function useBlobBytes(id: string): BlobState {
  const [state, setState] = useState<BlobState>(NO_BYTES)

  // A run token: a stale fetch resolving late must not overwrite the next
  // document's state.
  const runRef = useRef(0)

  useEffect(() => {
    const run = ++runRef.current
    const current = () => runRef.current === run
    setState(NO_BYTES)
    void (async () => {
      try {
        const answer = await bytesUrl(id, current, (from) => {
          if (current()) setState({ ...NO_BYTES, fetchingFrom: from })
        })
        if (!current()) return
        if ('unavailable' in answer) {
          setState({ ...NO_BYTES, unavailable: answer.unavailable })
          return
        }
        const res = await fetch(answer.url)
        if (!res.ok) throw new Error(`Storage returned ${res.status}`)
        const bytes = await res.arrayBuffer()
        if (current()) setState({ ...NO_BYTES, bytes })
      } catch (err) {
        if (current())
          setState({
            ...NO_BYTES,
            error: err instanceof Error ? err.message : 'Could not load file',
          })
      }
    })()
  }, [id])

  return state
}

/** The two states a `remote` file adds, in the page's own shapes. */
function BytesPending({
  state,
  label,
}: {
  state: BlobState
  label: string
}): ReactNode {
  if (state.unavailable !== null) return <Notice>{state.unavailable}</Notice>
  if (state.error !== null)
    return <Notice>Could not load the file — {state.error}</Notice>
  if (state.fetchingFrom !== null)
    return <Working label={`Fetching from ${state.fetchingFrom}…`} />
  return <Working label={label} />
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
  const blob = useBlobBytes(doc.id)
  const { pdf, error: parseError } = usePdf(blob.bytes)
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

  // Terminal states replace the page; while bytes are on their way the
  // column stays mounted, so its width is measured once it is.
  if (blob.unavailable !== null || blob.error !== null)
    return <BytesPending state={blob} label="Loading PDF…" />
  const failure = parseError ?? renderError
  if (failure)
    return <Notice>This PDF could not be rendered — {failure}</Notice>

  return (
    <div className="flex h-full">
      {pdf && pdf.numPages > 1 ? (
        <Thumbnails pdf={pdf} page={page} onPage={onPage} />
      ) : null}
      <div ref={columnRef} className="min-w-0 flex-1 overflow-auto p-6">
        {pdf ? null : <BytesPending state={blob} label="Loading PDF…" />}
        <canvas
          ref={canvasRef}
          aria-label={`${doc.filename}, page ${page}`}
          className={cn(
            'mx-auto rounded-none border border-hairline bg-paper',
            !pdf && 'hidden',
          )}
        />
        {pdf ? (
          <p
            data-page-caption
            className="mt-3 text-center mono text-micro text-graphite"
          >
            Page {page} of {pdf.numPages}
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
  const blob = useBlobBytes(doc.id)
  const { bytes } = blob
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) return
    // The type is ours, not the upload's — that is the whole safety property.
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [bytes, type])

  if (bytes === null)
    return <BytesPending state={blob} label="Loading image…" />
  if (!url) return <Working label="Loading image…" />

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
      <Working label={blobless ? 'Fetching the page…' : 'Extracting text…'} />
    )
  if (loading) return <Working label="Loading…" />

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
