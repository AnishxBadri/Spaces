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
 * The vision lane: the upgrade path for a scanned PDF with no text layer
 * (`extraction_status: 'unsupported'`).
 *
 * - The one place AI writes to a document rather than proposing, because it
 *   is extraction: `ExtractionStore.markExtracted` then `onExtracted`, so
 *   chunking, embedding and classify follow as for a text layer.
 * - No rasterizer: the PDF bytes go to the vision provider as a `file` part
 *   and the provider renders the pages (no native canvas, poppler or wasm).
 * - The memory bound is the chunk: `visionChunks` yields one
 *   `VISION_PAGES_PER_CHUNK`-page PDF at a time, never all at once.
 * - One `complete('vision', …)` call, so one `ai_usage` row, per chunk.
 * - A sensitive scan goes to a local model or is refused by `complete()`.
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
