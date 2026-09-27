import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import type { PDFDocument } from 'pdf-lib'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { visionReadable } from '#/lib/documents/vision-gate'
import { completeMessage } from './complete'
import type { CompleteFailure } from './complete'
import { providerFailure } from './providers/test-call'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * The vision lane (SPA-94; docs/spec-ai-substrate.md §9, §11's last-but-one
 * row, §14 step 8): the upgrade path for `extraction_status: 'unsupported'` —
 * a scanned PDF whose pages carry no text layer. It is **the one place the
 * AI writes to a document** rather than proposing, because it _is_
 * extraction: the answer lands in `extracted_text` and `tsv` through the
 * extraction job's own statement (`ExtractionStore.markExtracted`) and hands
 * on through the extraction job's own seam (`ExtractionStore.onExtracted`),
 * so chunking, embedding and classify follow exactly as they follow a text
 * layer. `lib/documents/ai-document-write.test.ts` holds that exception to
 * its one tenant.
 *
 * **No rasterizer (owner decision, 2026-09-27).** The PDF bytes themselves
 * go to the routed vision provider as a `file` part, and the provider
 * renders the pages. Considered and rejected:
 *
 *   - `@napi-rs/canvas` behind unpdf's `renderPageAsImage` — pdf.js is
 *     already here, but rendering needs a canvas backend, and that is a
 *     prebuilt native binary per platform in a two-container image;
 *   - poppler (`pdftoppm`) — a system package in the image and a child
 *     process per page;
 *   - pdfium compiled to wasm — no native binary, but tens of megabytes of
 *     wasm and a page bitmap in memory per render.
 *
 * Each would be a dependency doing work the provider does anyway: every
 * vision-capable provider we route to (Anthropic, OpenAI, Google, and
 * Ollama through `ollama-ai-provider-v2`, which declares `application/pdf`)
 * accepts a PDF and rasterizes it on its side. So there are no page images
 * here at all, and no image-size bound to keep — the bound is on PDF bytes.
 *
 * **The memory bound is the chunk.** The source PDF is held once (as the
 * extraction job already holds it), parsed once by `pdf-lib` (pure JS, no
 * native code), and cut into page ranges of `VISION_PAGES_PER_CHUNK`; each
 * range is written out as its own small PDF, sent, and dropped before the
 * next is made — `visionChunks` yields one `Uint8Array` at a time and the
 * caller awaits the model before asking for the next, so a 200-page scan is
 * ten 20-page requests, never ten buffers at once. Twenty pages also sits
 * well under every provider's per-request page ceiling (Anthropic's is 100).
 *
 * **Usage.** One `complete('vision', …)` call per chunk, so one `ai_usage`
 * row per chunk under lane `vision`. Providers report tokens per request,
 * not per page, so a per-chunk row is the honest grain; the chunk's page
 * range is fixed by `VISION_PAGES_PER_CHUNK` and the row's order within the
 * job run, and the job's log line names each range.
 *
 * **Sensitivity** is routed exactly as every other call: `complete()`
 * refuses a sensitive document to the cloud (`SensitiveRouteRefused`), so
 * a sensitive scan goes to a local model or is refused, never rasterized
 * here as a fallback.
 */

/** Pages per request, and so the most PDF bytes in flight at once. */
export const VISION_PAGES_PER_CHUNK = 20

/**
 * What a page is taken to cost, in prompt characters, for the cap's
 * estimate (`estimateTokens` is chars / 4): a rendered page is ~1,500–3,000
 * input tokens at the providers we route to, and its transcription a few
 * hundred more, so 12,000 characters (3,000 tokens) a page is the ceiling.
 */
export const VISION_CHARS_PER_PAGE = 12_000

/** Output ceiling per chunk: a dense page transcribes to ~1,000 tokens. */
export const VISION_MAX_OUTPUT_TOKENS_PER_PAGE = 1_500

/** Extraction's own ceiling (`@spaces/core/documents/extract`). */
const MAX_TEXT_CHARS = 2_000_000

export type PageRange = { first: number; last: number }

/** 1-based, inclusive page ranges of at most `size` pages covering `count`. */
export function pageRanges(
  count: number,
  size: number = VISION_PAGES_PER_CHUNK,
): Array<PageRange> {
  const step = Math.max(1, Math.floor(size))
  const out: Array<PageRange> = []
  for (let first = 1; first <= count; first += step)
    out.push({ first, last: Math.min(count, first + step - 1) })
  return out
}

/** The source, parsed once. Encryption flags do not stop a copy of pages. */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  const { PDFDocument } = await import('pdf-lib')
  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  })
}

/** One page range written out as a PDF of its own. */
export async function chunkBytes(
  src: PDFDocument,
  range: PageRange,
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const out = await PDFDocument.create({ updateMetadata: false })
  const indices = Array.from(
    { length: range.last - range.first + 1 },
    (_, i) => range.first - 1 + i,
  )
  for (const page of await out.copyPages(src, indices)) out.addPage(page)
  return out.save()
}

/**
 * The chunks, lazily: each `Uint8Array` is made when the caller asks for it,
 * so a caller that awaits the model between asks never holds two.
 */
export async function* visionChunks(
  src: PDFDocument,
  size: number = VISION_PAGES_PER_CHUNK,
): AsyncGenerator<{ range: PageRange; bytes: Uint8Array }> {
  for (const range of pageRanges(src.getPageCount(), size))
    yield { range, bytes: await chunkBytes(src, range) }
}

export const visionTask = (range: PageRange, filename: string): string =>
  [
    `The attached PDF is ${range.first === range.last ? `page ${String(range.first)}` : `pages ${String(range.first)}–${String(range.last)}`} of "${filename}", a scanned document with no text layer.`,
    'Transcribe the text of every page in reading order: headings, body text, table cells row by row, chart labels and figures.',
    `Begin each page with its marker on a line of its own — [Page ${String(range.first)}] for the first attached page, then the next number for each page after it — and write that page’s text under it.`,
    'Write only what the page shows. Do not summarise, translate, describe pictures or add commentary. A page with no text gets its marker and nothing under it.',
  ].join('\n')

const PAGE_MARKER = /^\[Page (\d+)\]$/
const FENCE = /^```[a-z]*$/

/**
 * The model's answer for one range, as the extractor's page sections
 * (`[Page N]` markers, the shape the chunker cuts on). A marker numbered
 * inside the range is taken as written; one numbered 1…n where the range
 * starts later is read as relative to the range; anything else continues
 * the page before it. Text before the first marker belongs to the first
 * page. Pages with no text are left out, as the extractor leaves them out.
 */
export function pageSections(
  answer: string,
  range: PageRange,
): Array<{ page: number; text: string }> {
  const size = range.last - range.first + 1
  const pages = new Map<number, Array<string>>()
  let current = range.first
  for (const raw of answer.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (FENCE.test(line)) continue
    const marker = PAGE_MARKER.exec(line)
    if (marker) {
      const n = Number(marker[1])
      if (n >= range.first && n <= range.last) current = n
      else if (n >= 1 && n <= size) current = range.first + n - 1
      continue
    }
    const lines = pages.get(current) ?? []
    lines.push(raw)
    pages.set(current, lines)
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, lines]) => ({ page, text: lines.join('\n').trim() }))
    .filter((p) => p.text !== '')
}

/** Every chunk's sections as one `extracted_text`, capped as extraction is. */
export function visionText(
  sections: ReadonlyArray<{ page: number; text: string }>,
): string {
  const text = sections.map((s) => `[Page ${String(s.page)}]\n${s.text}`)
  return text.join('\n\n').slice(0, MAX_TEXT_CHARS)
}

// ---------- failures ----------

/** The document is not one vision reads, or is gone. Leaves the row alone. */
export class VisionRefused extends Schema.TaggedError<VisionRefused>()(
  'VisionRefused',
  { message: Schema.String },
) {}

export class VisionQueryFailed extends Schema.TaggedError<VisionQueryFailed>()(
  'VisionQueryFailed',
  { cause: Schema.Defect() },
) {}

/** The PDF could not be cut into page ranges, or the model read no text. */
export class VisionReadFailed extends Schema.TaggedError<VisionReadFailed>()(
  'VisionReadFailed',
  { message: Schema.String },
) {}

export type VisionFailure =
  | VisionRefused
  | VisionQueryFailed
  | VisionReadFailed
  | CompleteFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

/**
 * The sentence a failed run leaves — on its job for the toast, and, for a
 * failure of the read itself, in `extraction_error`. A provider that
 * answered with an error keeps its own words.
 */
export function visionMessage(failure: VisionFailure): string {
  switch (failure._tag) {
    case 'VisionRefused':
    case 'VisionReadFailed':
      return failure.message
    case 'VisionQueryFailed':
      return 'Could not read the document'
    case 'SensitivityReadFailed':
      return 'Could not read the document’s sensitivity'
    case 'SensitivityEntityNotFound':
      return 'That document is gone'
    case 'ProviderCallFailed':
      return `${completeMessage(failure)}: ${providerFailure(failure.cause).message}`
    default:
      return completeMessage(failure)
  }
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new VisionQueryFailed({ cause }),
  })

// ---------- trigger + status (the Files tab's two server fns) ----------

export type VisionEnqueued =
  | { status: 'queued' }
  | { status: 'already-reading' }
  | { status: 'queue-unavailable' }

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

/**
 * Press Read with vision: one `document.vision` job keyed on the document,
 * on an `exclusive` queue — the deck reader's trigger. The same check the
 * row's gate made in the browser (`visionReadable`) is made again here, so
 * a stale tab cannot queue a read of a document that has since extracted.
 */
export const enqueueVisionProgram = Effect.fn('enqueueVision')(function* (
  documentId: string,
  userId: string,
): Effect.fn.Return<VisionEnqueued, VisionRefused | VisionQueryFailed> {
  const doc = (yield* query(() =>
    db
      .select({
        extractionStatus: document.extractionStatus,
        blobSha: document.blobSha,
        filename: document.filename,
        mime: document.mime,
      })
      .from(document)
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (!doc)
    return yield* new VisionRefused({ message: 'That document is gone' })
  if (!visionReadable(doc))
    return yield* new VisionRefused({
      message: 'Only a stored PDF with no text layer is read with vision',
    })
  const jobId = yield* query(() =>
    enqueue(
      QUEUES.visionDocument,
      { documentId, userId },
      { singletonKey: documentId },
    ),
  )
  if (jobId !== null) return { status: 'queued' }
  const jobs = yield* query(() => jobsByKey(QUEUES.visionDocument, documentId))
  return jobs !== null && jobs.some(inFlight)
    ? { status: 'already-reading' }
    : { status: 'queue-unavailable' }
})

export type VisionStatus =
  | { state: 'idle' }
  | { state: 'reading' }
  | { state: 'done'; at: string }
  | { state: 'failed'; message: string; at: string }

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
function reasonOf(output: object | null): string | null {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** The latest job for a document, as the button reads it. */
export function visionStatusOf(jobs: ReadonlyArray<QueuedJob>): VisionStatus {
  const latest = [...jobs]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { state: 'idle' }
  if (inFlight(latest)) return { state: 'reading' }
  const at = latest.createdOn.toISOString()
  if (latest.state === 'completed') return { state: 'done', at }
  return {
    state: 'failed',
    message: reasonOf(latest.output) ?? 'The document could not be read',
    at,
  }
}

export const visionStatusProgram = Effect.fn('visionStatus')(function* (
  documentIds: ReadonlyArray<string>,
): Effect.fn.Return<Record<string, VisionStatus>, VisionQueryFailed> {
  const out: Record<string, VisionStatus> = {}
  for (const id of documentIds) {
    const jobs = yield* query(() => jobsByKey(QUEUES.visionDocument, id))
    out[id] = jobs === null ? { state: 'idle' } : visionStatusOf(jobs)
  }
  return out
})
