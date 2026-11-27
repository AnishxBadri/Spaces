import { Email, WarningAlt } from '#/components/icons'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { PDFDocumentProxy } from 'unpdf/pdfjs'
import { Twinkle } from './twinkle'
import { SearchField } from './ui/search-field'
import { Segmented } from './ui/segmented'
import { Tabs } from './ui/tabs'
import { useKeepCopy } from './files/keep-copy'
import { detectFormat } from '@spaces/core/documents/extract'
import {
  findInDocument,
  getDocumentBytes,
  getDocumentText,
} from '#/lib/server-fns'
import { MIN_QUERY, hitsLine, markRuns } from '#/lib/documents/find-text'
import type { FindHits } from '#/lib/documents/find-text'
import type { RemoteBytes } from '#/lib/documents/files-tab'
import { cn } from '#/lib/utils'

/**
 * The file viewer's body: its tool bar and the file itself, the same in the
 * file's window and on its page; `FileView` puts the head and the rail round
 * it.
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
 *   connection; a connection in error is said in the page, never blank. An
 *   email attachment still in its mailbox opens the same way, through
 *   Gmail; one whose mailbox was disconnected opens its text.
 */

/** What the body reads of a file. */
export type ViewerDoc = {
  id: string
  filename: string
  mime: string | null
  sizeBytes: number | null
  extractionStatus: string
  extractionError: string | null
  /** Null when there are no bytes to fetch — a clipped article. */
  blobSha: string | null
  /** The page a clip was read from, and null on every row that had bytes. */
  url: string | null
  /** The newer version that supersedes this file; the tool bar says so. */
  replacedBy?: { id: string; name: string } | null
  /** An email attachment whose file stays in its mailbox. */
  remoteBytes?: RemoteBytes | undefined
}

/**
 * No file to fetch: a clip, or an attachment whose mailbox was
 * disconnected. One still in the mailbox opens through it.
 */
export const blobless = (doc: ViewerDoc) =>
  doc.blobSha === null && doc.remoteBytes !== 'linked'

/** Raster types only — SVG can carry script and is deliberately absent. */
const PREVIEWABLE_IMAGES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
])

function imageType(doc: ViewerDoc): string | null {
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

/** The zoom: fitted to the body, or a scale the reader chose. */
type Zoom = 'fit' | number

/** A page or an image at scale 1, in CSS pixels. */
type Size = { w: number; h: number }

/** The body's padding round the pages, the `p-6` a fit leaves free. */
const GUTTER = 24
/** The query waits this long after the last key before it asks. */
const FIND_DEBOUNCE_MS = 250
/** The longest query the find fn takes. */
const FIND_MAX = 200

/** A jump the tool bar or the rail asks the page column for. */
type Jump = { page: number; seq: number }

/**
 * The tool bar and the file under it. `startPage` is the 1-based page a PDF
 * opens at. Keyed by the file's id where it mounts, so another file starts
 * on its own first page.
 */
export function FileBody({
  doc,
  startPage,
}: {
  doc: ViewerDoc
  startPage: number
}) {
  const format = detectFormat(doc.filename, doc.mime)
  const asImage = imageType(doc)
  const noFile = blobless(doc)
  const isPdf = !noFile && format === 'pdf'
  const isImage = !noFile && !isPdf && asImage !== null
  // The stored text: what find searches and what `Text` shows.
  const hasText = doc.extractionStatus === 'done'
  const [mode, setMode] = useState<'pages' | 'text'>('pages')
  const showPages = isPdf && mode === 'pages'
  const [page, setPage] = useState(Math.max(1, startPage))
  const [jump, setJump] = useState<Jump>({ page: startPage, seq: 0 })
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [fitScale, setFitScale] = useState(1)
  const scale = zoom === 'fit' ? fitScale : zoom
  const onPages = useCallback((n: number) => {
    setPages(n)
    // A page past the end (the file was replaced) opens on the last.
    setPage((p) => Math.min(p, n))
  }, [])
  const go = useCallback((n: number) => {
    setPage(n)
    setJump((j) => ({ page: n, seq: j.seq + 1 }))
  }, [])

  const finds = hasText && !isImage
  const [query, setQuery] = useState('')
  const hits = useFind(doc.id, finds ? query : '')
  const hitPages = useMemo(
    () =>
      new Set(
        (hits?.pages ?? []).flatMap((p) => (p.page === null ? [] : [p.page])),
      ),
    [hits],
  )

  // `Enter` in `Text` (and a sheet) steps through the marks in the body.
  const bodyRef = useRef<HTMLDivElement>(null)
  const markAt = useRef(-1)
  useEffect(() => {
    markAt.current = -1
  }, [query, mode])
  const next = () => {
    if (showPages) {
      const sorted = [...hitPages].sort((a, b) => a - b)
      const after = sorted.find((p) => p > page) ?? sorted.at(0)
      if (after !== undefined) go(after)
      return
    }
    const marks = bodyRef.current?.querySelectorAll('[data-hit]')
    if (!marks || marks.length === 0) return
    if (markAt.current >= 0)
      marks.item(markAt.current).removeAttribute('data-current')
    markAt.current = (markAt.current + 1) % marks.length
    const mark = marks.item(markAt.current)
    mark.setAttribute('data-current', '')
    mark.scrollIntoView({ block: 'center' })
  }

  const replaced = doc.replacedBy ?? null
  const switches = isPdf && hasText
  const pager = showPages && pages > 1
  const zooms = showPages || isImage
  const tools = switches || pager || zooms || finds || replaced !== null
  const zoomIn = () => setZoom(Math.min(4, scale * 1.25))
  const zoomOut = () => setZoom(Math.max(0.25, scale / 1.25))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tools ? (
        <div
          data-viewer-tools
          className="flex h-11 shrink-0 items-center gap-4 border-b border-rule bg-paper px-6"
        >
          {switches ? (
            <Segmented
              label="Show"
              value={mode}
              onChange={setMode}
              options={[
                { id: 'pages', label: 'Pages' },
                { id: 'text', label: 'Text' },
              ]}
            />
          ) : null}
          {pager ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => go(Math.max(1, page - 1))}
                className="focus-ring flex size-6 items-center justify-center rounded-md text-ui text-foreground hover:bg-bone disabled:text-graphite disabled:hover:bg-transparent"
              >
                ‹
              </button>
              <span className="tabular mono text-label text-foreground">
                {page} / {pages}
              </span>
              <button
                type="button"
                aria-label="Next page"
                disabled={page >= pages}
                onClick={() => go(Math.min(pages, page + 1))}
                className="focus-ring flex size-6 items-center justify-center rounded-md text-ui text-foreground hover:bg-bone disabled:text-graphite disabled:hover:bg-transparent"
              >
                ›
              </button>
            </div>
          ) : null}
          {zooms ? (
            <div className="flex shrink-0 items-center gap-0.5 mono text-label text-foreground">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={zoomOut}
                className="focus-ring flex h-6 min-w-6 items-center justify-center rounded-md px-1 hover:bg-bone"
              >
                −
              </button>
              <button
                type="button"
                aria-label="Fit"
                aria-pressed={zoom === 'fit'}
                onClick={() => setZoom('fit')}
                className="focus-ring flex h-6 items-center justify-center rounded-md px-1 hover:bg-bone"
              >
                Fit
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={zoomIn}
                className="focus-ring flex h-6 min-w-6 items-center justify-center rounded-md px-1 hover:bg-bone"
              >
                +
              </button>
            </div>
          ) : null}
          {replaced === null ? null : (
            <span className="min-w-0 truncate mono text-micro text-graphite">
              Replaced by → {replaced.name}
            </span>
          )}
          <span className="flex-1" />
          {finds ? (
            <div
              className="contents"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                next()
              }}
            >
              <SearchField
                value={query}
                onValueChange={(v) => setQuery(v.slice(0, FIND_MAX))}
                placeholder="Find in file"
                label="Find in file"
                className="w-60"
                count={
                  hits === null || query.trim().length < MIN_QUERY
                    ? undefined
                    : hitsLine(hits)
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bone">
        {doc.remoteBytes === 'linked' ? <InGmail id={doc.id} /> : null}
        <div
          ref={bodyRef}
          className={cn(
            'min-h-0 min-w-0 flex-1',
            showPages ? 'flex overflow-hidden' : 'overflow-auto',
          )}
        >
          {noFile || (isPdf && mode === 'text') ? (
            <TextPreview doc={doc} format={format} query={query} />
          ) : isPdf ? (
            <PdfPreview
              doc={doc}
              page={page}
              jump={jump}
              zoom={zoom}
              hitPages={hitPages}
              onPages={onPages}
              onPage={setPage}
              onPick={go}
              onFitScale={setFitScale}
            />
          ) : isImage ? (
            <ImagePreview
              doc={doc}
              type={asImage}
              zoom={zoom}
              onFitScale={setFitScale}
            />
          ) : (
            <TextPreview doc={doc} format={format} query={query} />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The find's answer for the query in the field, asked a moment after the
 * last key; null with no query, and the last answer while the next is out.
 */
function useFind(id: string, query: string): FindHits | null {
  const [hits, setHits] = useState<FindHits | null>(null)
  const q = query.trim()
  useEffect(() => {
    if (q.length < MIN_QUERY) {
      setHits(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      findInDocument({ data: { id, query: q } })
        .then((r) => live && setHits(r))
        .catch(() => live && setHits(null))
    }, FIND_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [id, q])
  return hits
}

/** The line over the body for a file whose bytes stay in Gmail. */
function InGmail({ id }: { id: string }) {
  const keeper = useKeepCopy()
  return (
    <div
      data-in-gmail
      className="mx-6 mt-3 flex h-11 shrink-0 items-center gap-2.5 border border-hairline bg-paper px-3.5"
    >
      <Email aria-hidden className="size-4 shrink-0 text-foreground" />
      <p className="min-w-0 flex-1 truncate text-ui text-foreground">
        The file is in Gmail. Only its text is kept here.
      </p>
      <button
        type="button"
        disabled={keeper.busy}
        onClick={() => void keeper.keep(id)}
        className="focus-ring flex h-7 shrink-0 items-center rounded-md border border-hairline bg-paper px-2.5 text-ui text-foreground hover:bg-bone disabled:text-graphite"
      >
        {keeper.busy ? 'Keeping a copy…' : 'Keep a copy'}
      </button>
    </div>
  )
}

/** Shared framing for "there is nothing to show, and here is why". */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <WarningAlt className="mb-3 size-5 text-graphite" />
        <p className="text-ui text-graphite">{children}</p>
      </div>
    </div>
  )
}

/** The pane while the file is on its way: the Twinkle over one line. */
function Working({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-ui text-graphite">
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
export async function bytesUrl(
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
          // which is why only the pages near the viewport are ever drawn.
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

/**
 * Every page's size at scale 1, so the column is laid out before a page is
 * drawn. All pages take the first page's size at once and their own as the
 * read reaches them: reading a size parses the page, never renders it.
 */
function usePageSizes(pdf: PDFDocumentProxy | null): Array<Size> | null {
  const [sizes, setSizes] = useState<Array<Size> | null>(null)
  useEffect(() => {
    if (!pdf) return
    // Asked, not read: the cleanup flips it between awaits.
    let stopped = false
    const live = () => !stopped
    void (async () => {
      const sizeOf = async (n: number): Promise<Size> => {
        const v = (await pdf.getPage(n)).getViewport({ scale: 1 })
        return { w: v.width, h: v.height }
      }
      try {
        const first = await sizeOf(1)
        const all = Array.from({ length: pdf.numPages }, () => first)
        if (!live()) return
        setSizes([...all])
        let changed = false
        for (let n = 2; n <= pdf.numPages && live(); n++) {
          const s = await sizeOf(n)
          if (s.w !== first.w || s.h !== first.h) {
            all[n - 1] = s
            changed = true
          }
        }
        if (live() && changed) setSizes([...all])
      } catch {
        // A page that will not parse says so when it is drawn.
      }
    })()
    return () => {
      stopped = true
    }
  }, [pdf])
  return sizes
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

/** A render cancelled by scrolling or zooming away is not a failure. */
const cancelled = (err: unknown) =>
  /cancel/i.test(err instanceof Error ? err.message : String(err))

/** How far past the viewport, above and below, a page is drawn. */
const NEAR_MARGIN = '100% 0px'

/**
 * The pages as one column on bone beside the page rail.
 * - Every page has its slot at its size from the start, so the scroll bar
 *   is the whole file; only the slots near the viewport hold a canvas, and a
 *   slot that scrolls away gives its canvas back.
 * - The page in view is the one showing most of itself; the pager reads it.
 * - A jump (the pager, a thumbnail, `Enter`) and a zoom put the current
 *   page's top at the top of the column.
 */
function PdfPreview({
  doc,
  page,
  jump,
  zoom,
  hitPages,
  onPages,
  onPage,
  onPick,
  onFitScale,
}: {
  doc: ViewerDoc
  page: number
  jump: Jump
  zoom: Zoom
  hitPages: ReadonlySet<number>
  onPages: (pages: number) => void
  onPage: (page: number) => void
  onPick: (page: number) => void
  onFitScale: (scale: number) => void
}) {
  const blob = useBlobBytes(doc.id)
  const { pdf, error: parseError } = usePdf(blob.bytes)
  const sizes = usePageSizes(pdf)
  const scrollRef = useRef<HTMLDivElement>(null)
  const slots = useRef<Array<HTMLDivElement | null>>([])
  const [width, setWidth] = useState(0)
  const [near, setNear] = useState<ReadonlySet<number>>(new Set())
  const [renderError, setRenderError] = useState<string | null>(null)

  useEffect(() => {
    if (pdf) onPages(pdf.numPages)
  }, [pdf, onPages])

  // The column's width, so `Fit` fits the widest page to what is there.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [pdf])

  const widest = sizes ? Math.max(...sizes.map((s) => s.w)) : 0
  const fit =
    widest > 0 && width > 0
      ? Math.max(0.25, (width - 2 * GUTTER - 2) / widest)
      : 1
  const scale = zoom === 'fit' ? fit : zoom
  useEffect(() => {
    onFitScale(fit)
  }, [fit, onFitScale])
  const ready = pdf !== null && sizes !== null && width > 0

  // Which slots are within a viewport of the visible part of the column.
  useEffect(() => {
    const root = scrollRef.current
    if (!ready || !root || typeof IntersectionObserver === 'undefined') return
    const seen = new Set<number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number(e.target.getAttribute('data-page'))
          if (e.isIntersecting) seen.add(n)
          else seen.delete(n)
        }
        setNear(new Set(seen))
      },
      { root, rootMargin: NEAR_MARGIN },
    )
    for (const slot of slots.current) if (slot) observer.observe(slot)
    return () => observer.disconnect()
  }, [ready])

  // The page under the jump or the zoom is put at the top; the scroll that
  // causes is not read back as the reader's, or a short last page would
  // hand the pager the page under it.
  const pageRef = useRef(page)
  pageRef.current = page
  const jumping = useRef(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const slot = slots.current[pageRef.current - 1]
    if (!ready || !el || !slot) return
    jumping.current = true
    el.scrollTop = slot.offsetTop - GUTTER
    const timer = setTimeout(() => {
      jumping.current = false
    }, 100)
    return () => clearTimeout(timer)
  }, [ready, scale, jump.seq])

  const frame = useRef(0)
  const follow = () => {
    if (jumping.current) return
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      const n = pageInView(slots.current, el.scrollTop, el.clientHeight)
      if (n !== null && n !== pageRef.current) onPage(n)
    })
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Terminal states replace the column; while bytes are on their way it
  // stays mounted, so its width is measured once they are.
  if (blob.unavailable !== null || blob.error !== null)
    return <BytesPending state={blob} label="Loading PDF…" />
  const failure = parseError ?? renderError
  if (failure)
    return <Notice>This PDF could not be rendered — {failure}</Notice>

  return (
    <>
      {pdf && sizes && pdf.numPages > 1 ? (
        <Thumbnails
          pdf={pdf}
          sizes={sizes}
          page={page}
          hitPages={hitPages}
          onPick={onPick}
        />
      ) : null}
      <div
        ref={scrollRef}
        onScroll={follow}
        data-page-column
        className="relative min-w-0 flex-1 overflow-auto"
      >
        {ready ? (
          <div className="flex w-max min-w-full flex-col items-center gap-4 p-6">
            {sizes.map((s, i) => {
              const n = i + 1
              const w = Math.floor(s.w * scale)
              const h = Math.floor(s.h * scale)
              return (
                <div
                  key={n}
                  ref={(el) => {
                    slots.current[i] = el
                  }}
                  data-page={n}
                  role="img"
                  aria-label={`${doc.filename}, page ${n}`}
                  style={{ width: w, height: h }}
                  className="box-content shrink-0 border border-rule bg-paper"
                >
                  {near.has(n) ? (
                    <PageCanvas
                      pdf={pdf}
                      n={n}
                      scale={scale}
                      onError={setRenderError}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <BytesPending state={blob} label="Loading PDF…" />
        )}
      </div>
    </>
  )
}

/**
 * The 1-based page showing most of itself between `top` and `top + height`,
 * found by halving to the first slot still in view.
 */
function pageInView(
  slots: ReadonlyArray<HTMLDivElement | null>,
  top: number,
  height: number,
): number | null {
  const bottom = top + height
  let lo = 0
  let hi = slots.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const s = slots[mid]
    if (s && s.offsetTop + s.offsetHeight <= top) lo = mid + 1
    else hi = mid
  }
  let best: number | null = null
  let most = -1
  for (let i = lo; i < slots.length; i++) {
    const s = slots[i]
    if (!s) continue
    if (s.offsetTop >= bottom) break
    const shown =
      Math.min(s.offsetTop + s.offsetHeight, bottom) -
      Math.max(s.offsetTop, top)
    if (shown > most) {
      most = shown
      best = i + 1
    }
  }
  return best
}

/** One page's canvas while its slot is near the viewport; released on leaving. */
function PageCanvas({
  pdf,
  n,
  scale,
  onError,
}: {
  pdf: PDFDocumentProxy
  n: number
  scale: number
  onError: (message: string) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let task: { cancel: () => void } | null = null
    void drawPage(
      pdf,
      n,
      canvas,
      () => scale,
      (t) => {
        task = t
      },
    ).catch((err: unknown) => {
      if (!cancelled(err))
        onError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      task?.cancel()
    }
  }, [pdf, n, scale, onError])
  // A canvas's backing store outlives its element until it is zeroed.
  useEffect(
    () => () => {
      const canvas = ref.current
      if (!canvas) return
      canvas.width = 0
      canvas.height = 0
    },
    [],
  )
  return <canvas ref={ref} aria-hidden className="block" />
}

/** The thumbnail's inner width: 78px less its 1px border each side. */
const THUMB_W = 76

/**
 * The page rail: every page small, with its number. The page in view has
 * the ink outline and is kept in the rail's view; a page with a find hit
 * carries an ink square. Each thumbnail draws once it scrolls into the rail.
 */
function Thumbnails({
  pdf,
  sizes,
  page,
  hitPages,
  onPick,
}: {
  pdf: PDFDocumentProxy
  sizes: ReadonlyArray<Size>
  page: number
  hitPages: ReadonlySet<number>
  onPick: (page: number) => void
}) {
  const railRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const rail = railRef.current
    const item = rail?.children.item(page - 1)
    if (!rail || !(item instanceof HTMLElement)) return
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < rail.scrollTop) rail.scrollTop = top - 16
    else if (bottom > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = bottom - rail.clientHeight + 16
  }, [page])

  return (
    <ol
      ref={railRef}
      aria-label="Pages"
      data-page-rail
      className="relative flex w-31 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-rule px-3 py-4"
    >
      {sizes.map((s, i) => {
        const n = i + 1
        const current = n === page
        return (
          <li key={n} className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                'tabular w-3.5 shrink-0 text-right mono text-field',
                current ? 'font-semibold text-foreground' : 'text-graphite',
              )}
            >
              {n}
            </span>
            <Thumb
              pdf={pdf}
              n={n}
              height={Math.round((THUMB_W * s.h) / s.w)}
              current={current}
              hit={hitPages.has(n)}
              onPick={onPick}
            />
          </li>
        )
      })}
    </ol>
  )
}

function Thumb({
  pdf,
  n,
  height,
  current,
  hit,
  onPick,
}: {
  pdf: PDFDocumentProxy
  n: number
  height: number
  current: boolean
  hit: boolean
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
      (base) => THUMB_W / base,
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
      aria-label={hit ? `Page ${n}, found` : `Page ${n}`}
      aria-current={current ? 'page' : undefined}
      onClick={() => onPick(n)}
      className={cn(
        'focus-ring shrink-0 border bg-paper',
        // The ink outline is the border plus a ring outside it, so the
        // current page never shifts its neighbours.
        current
          ? 'border-hairline ring-1 ring-hairline'
          : 'border-rule hover:border-graphite',
      )}
    >
      <canvas ref={ref} style={{ width: THUMB_W, height }} className="block" />
      {hit ? (
        <span
          aria-hidden
          data-thumb-hit
          className="absolute top-1 right-1 size-1.25 bg-hairline"
        />
      ) : null}
    </button>
  )
}

/**
 * An image, centred on bone. `Fit` shows it whole in the body, never larger
 * than itself; a zoom is a scale of its own pixels and scrolls.
 */
function ImagePreview({
  doc,
  type,
  zoom,
  onFitScale,
}: {
  doc: ViewerDoc
  type: string
  zoom: Zoom
  onFitScale: (scale: number) => void
}) {
  const blob = useBlobBytes(doc.id)
  const { bytes } = blob
  const [url, setUrl] = useState<string | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!bytes) return
    // The type is ours, not the upload's — that is the whole safety property.
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [bytes, type])

  // What `Fit` comes to, so a zoom starts from the size on screen.
  useEffect(() => {
    const box = boxRef.current?.parentElement
    if (!natural || !box) return
    const measure = () =>
      onFitScale(
        Math.min(
          1,
          (box.clientWidth - 2 * GUTTER) / natural.w,
          (box.clientHeight - 2 * GUTTER) / natural.h,
        ),
      )
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [natural, onFitScale])

  if (bytes === null)
    return <BytesPending state={blob} label="Loading image…" />
  if (!url) return <Working label="Loading image…" />

  const zoomed = zoom !== 'fit' && natural !== null
  return (
    <div
      ref={boxRef}
      className={cn(
        'flex items-center justify-center p-6',
        zoomed ? 'min-h-full w-max min-w-full' : 'h-full',
      )}
    >
      <img
        src={url}
        alt={doc.filename}
        onLoad={(e) =>
          setNatural({
            w: e.currentTarget.naturalWidth,
            h: e.currentTarget.naturalHeight,
          })
        }
        style={zoomed ? { width: Math.round(natural.w * zoom) } : undefined}
        className={cn(
          'block shrink-0 rounded-none border border-rule bg-paper',
          zoomed ? 'max-w-none' : 'max-h-full max-w-full object-contain',
        )}
      />
    </div>
  )
}

/** Text with the find's hits marked; `Enter` steps the current mark. */
function Marked({ text, query }: { text: string; query: string }) {
  const runs = useMemo(() => markRuns(text, query), [text, query])
  if (runs.length === 1 && !runs[0].hit) return text
  return runs.map((r, i) =>
    r.hit ? (
      <mark
        key={i}
        data-hit
        className="bg-selected text-foreground data-current:bg-hairline data-current:text-paper"
      >
        {r.text}
      </mark>
    ) : (
      r.text
    ),
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
  query,
}: {
  doc: ViewerDoc
  format: ReturnType<typeof detectFormat>
  query: string
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

  // A clipped page: no bytes, and its address is the document.
  const clip = doc.blobSha === null && doc.url !== null
  const noFile = blobless(doc)

  if (doc.extractionStatus === 'pending')
    return <Working label={clip ? 'Fetching the page…' : 'Extracting text…'} />
  if (loading) return <Working label="Loading…" />

  if (!text) {
    return (
      <Notice>
        {doc.extractionError ??
          (clip
            ? 'No text was read from this page — open the source to read it.'
            : noFile
              ? 'No text was read from this file, and only its text is kept here.'
              : 'No preview for this file type — download it to open.')}
      </Notice>
    )
  }

  if (format === 'xlsx') return <SheetPreview text={text} query={query} />

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      {clip && doc.url !== null ? (
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
        <Marked text={text} query={query} />
      </pre>
    </div>
  )
}

/** A spreadsheet's rows as the extractor wrote them: `[Sheet]` blocks of tab-separated rows. */
type Sheet = { title: string | null; rows: Array<Array<string>> }

function sheetsOf(text: string): Array<Sheet> {
  return text
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
}

/**
 * The grid of one worksheet under folder tabs, one per sheet with its row
 * count; a file of one sheet has no tab bar.
 */
function SheetPreview({ text, query }: { text: string; query: string }) {
  const sheets = useMemo(() => sheetsOf(text), [text])
  const [open, setOpen] = useState('0')
  const sheet = sheets.at(Number(open)) ?? sheets.at(0)
  if (sheet === undefined) return null
  if (sheets.length === 1)
    return (
      <div className="px-6 pt-3 pb-6">
        <SheetGrid sheet={sheet} query={query} framed />
      </div>
    )
  return (
    <div className="px-6 pt-3 pb-6">
      <Tabs
        label="Sheets"
        value={open}
        onValueChange={setOpen}
        items={sheets.map((s, i) => ({
          id: String(i),
          uncounted: true,
          label: (
            <span className="inline-flex items-baseline gap-1.5">
              {s.title ?? `Sheet ${i + 1}`}
              <span className="tabular mono text-micro">
                {s.rows.length.toLocaleString('en-US')}{' '}
                {s.rows.length === 1 ? 'row' : 'rows'}
              </span>
            </span>
          ),
        }))}
      >
        <SheetGrid sheet={sheet} query={query} framed={false} />
      </Tabs>
    </div>
  )
}

/** One sheet's rows; `framed` draws the ink frame the folder draws under tabs. */
function SheetGrid({
  sheet,
  query,
  framed,
}: {
  sheet: Sheet
  query: string
  framed: boolean
}) {
  return (
    <div
      className={cn(
        'overflow-x-auto bg-paper',
        framed && 'border border-hairline',
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {sheet.rows.map((row, r) => (
            <tr key={r} className="h-8 border-b border-rule last:border-b-0">
              {row.map((cell, c) => {
                // Numbers align and read as numbers inside a preview too.
                const numeric =
                  cell.trim() !== '' && /^[-+]?[\d,.]+%?$/.test(cell.trim())
                return (
                  <td
                    key={c}
                    className={cn(
                      'border-r border-rule px-3 last:border-r-0',
                      // A leading header row is the near-universal shape of
                      // an exported sheet.
                      r === 0
                        ? 'bg-bone text-label text-graphite'
                        : numeric
                          ? 'numeric mono text-label text-foreground'
                          : 'text-ui text-foreground',
                    )}
                  >
                    <Marked text={cell} query={query} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
