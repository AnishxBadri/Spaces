import { strFromU8 } from 'fflate'
import { readXlsx } from '../import/read'
import { numbered, ooxmlRuns, unzip } from './ooxml'

/**
 * Text extraction, in-process, no extra containers (CONTEXT.md → Storage).
 * Pure functions over bytes so they unit-test without a database, a blob
 * store, or a worker; the worker is the only caller that does I/O.
 *
 * The outcome is a three-way distinction the UI has to make, not a boolean:
 * `unsupported` means "this file has no text layer we can reach" (a scanned
 * deck, an image) and is a permanent, explainable state — a BYOK vision
 * model is its upgrade path. `failed` means we tried and broke, which is a
 * bug or a corrupt file. Collapsing the two produces "extraction failed" on
 * a perfectly good photo of a term sheet.
 */

export type ExtractOutcome =
  | { status: 'done'; text: string; format: Format }
  | { status: 'unsupported'; reason: string; format: Format | 'unknown' }
  | { status: 'failed'; reason: string; format: Format | 'unknown' }

export type Format = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text'

/** Beyond this, more text buys search nothing and costs every row read. */
const MAX_TEXT_BYTES = 2_000_000

// Maps, not object literals: lookups on arbitrary filenames must type as
// possibly-absent, which a Record<string, Format> index quietly does not.
const BY_EXTENSION = new Map<string, Format>([
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['pptx', 'pptx'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsx'],
  ['xltx', 'xlsx'],
  ['pptm', 'pptx'],
  ['docm', 'docx'],
  ['txt', 'text'],
  ['md', 'text'],
  ['markdown', 'text'],
  ['csv', 'text'],
  ['tsv', 'text'],
  ['json', 'text'],
])

const BY_MIME = new Map<string, Format>([
  ['application/pdf', 'pdf'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-excel.sheet.macroenabled.12', 'xlsx'],
  ['application/vnd.ms-powerpoint.presentation.macroenabled.12', 'pptx'],
  ['application/vnd.ms-word.document.macroenabled.12', 'docx'],
  ['text/plain', 'text'],
  ['text/markdown', 'text'],
  ['text/csv', 'text'],
  ['application/json', 'text'],
])

/**
 * Extension wins over mime: browsers report `application/octet-stream` for
 * plenty of real .pptx files, and Gmail attachments are worse.
 */
export function detectFormat(
  filename?: string | null,
  mime?: string | null,
): Format | null {
  const ext = filename?.toLowerCase().split('.').pop()
  const byExtension = ext ? BY_EXTENSION.get(ext) : undefined
  if (byExtension) return byExtension

  const type = mime?.toLowerCase().split(';')[0].trim()
  const byMime = type ? BY_MIME.get(type) : undefined
  if (byMime) return byMime

  if (type?.startsWith('text/')) return 'text'
  return null
}

export async function extractDocumentText(input: {
  bytes: Uint8Array
  filename?: string | null
  mime?: string | null
}): Promise<ExtractOutcome> {
  const format = detectFormat(input.filename, input.mime)
  if (!format) {
    return {
      status: 'unsupported',
      format: 'unknown',
      reason: `No text extractor for ${input.mime ?? input.filename ?? 'this file type'}`,
    }
  }

  try {
    const text = normalize(await runExtractor(format, input.bytes))
    if (text.length === 0) {
      return {
        status: 'unsupported',
        format,
        reason:
          format === 'pdf'
            ? 'No text layer — likely a scanned PDF. Extractable once a vision model key is configured.'
            : 'File contains no extractable text',
      }
    }
    return { status: 'done', format, text }
  } catch (err) {
    return {
      status: 'failed',
      format,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

function runExtractor(format: Format, bytes: Uint8Array): Promise<string> {
  switch (format) {
    case 'pdf':
      return fromPdf(bytes)
    case 'docx':
      return fromDocx(bytes)
    case 'pptx':
      return Promise.resolve(fromPptx(bytes))
    case 'xlsx':
      return Promise.resolve(fromXlsx(bytes))
    case 'text':
      return Promise.resolve(strFromU8(bytes))
  }
}

/**
 * Collapse the whitespace OOXML and pdf.js both produce in quantity — but
 * never across tabs. Tabs are the spreadsheet extractor's column separator;
 * folding them into spaces turns a cap table back into prose.
 */
function normalize(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\t ?/g, '\t')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.length > MAX_TEXT_BYTES
    ? cleaned.slice(0, MAX_TEXT_BYTES)
    : cleaned
}

// ---------- pdf ----------

/**
 * Page-wise, under `[Page N]` markers in the shape fromPptx gives
 * `[Slide N]`: the page is what a citation names and what a chunk is cut on
 * (spec-ai-substrate §9). N is the page's real number, so a page with no
 * text layer is skipped rather than renumbering the rest — and a PDF that
 * is all scan comes back empty, which the caller reports as `unsupported`,
 * not as a column of bare markers.
 */
async function fromPdf(bytes: Uint8Array): Promise<string> {
  // Dynamic import: unpdf pulls in a pdf.js build, and the web process must
  // never load it — extraction is the worker's job.
  const { extractText, getDocumentProxy } = await import('unpdf')
  // getDocumentProxy transfers the buffer, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const { text: pages } = await extractText(pdf, { mergePages: false })

  const out: Array<string> = []
  pages.forEach((page, i) => {
    const body = page.trim()
    if (body) out.push(`[Page ${i + 1}]\n${body}`)
  })
  return out.join('\n\n')
}

// ---------- docx ----------

async function fromDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth')
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(bytes),
  })
  return value
}

// ---------- pptx ----------

/**
 * Decks matter most, so this reads more than the title placeholders: every
 * `a:t` run on a slide (which covers tables and grouped shapes), in slide
 * order, plus speaker notes — often where the actual numbers get said.
 */
function fromPptx(bytes: Uint8Array): string {
  const zip = unzip(bytes)
  const slides = numbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/)
  const notes = new Map(
    numbered(zip, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/).map((s) => [
      s.n,
      s.xml,
    ]),
  )
  if (slides.length === 0) return ''

  const out: Array<string> = []
  for (const slide of slides) {
    const body = ooxmlRuns(slide.xml, 'a:t').join('\n')
    const noteXml = notes.get(slide.n)
    const note = noteXml ? ooxmlRuns(noteXml, 'a:t').join('\n') : ''
    if (!body && !note) continue
    out.push(`[Slide ${slide.n}]\n${body}${note ? `\n[Notes]\n${note}` : ''}`)
  }
  return out.join('\n\n')
}

// ---------- xlsx ----------

/**
 * Cap tables and MIS sheets: values row-wise, tab-separated, under their real
 * sheet names. Sheet names carry meaning ("Cap Table (post)") — dropping them
 * for sheet1/sheet2 throws away the most searchable string in the file.
 *
 * The grid is the import reader's (`import/read.ts`, SPA-163), so search and
 * import read through one xlsx parser — including its date resolution, which
 * makes a date column searchable as 2023-03-15 rather than as 45000. The
 * blank cells the rectangular grid pads a short row with are layout, not
 * text, so they are dropped here.
 */
function fromXlsx(bytes: Uint8Array): string {
  const out: Array<string> = []
  for (const sheet of readXlsx(bytes)) {
    if (sheet.rows.length === 0) continue
    const rows = sheet.rows.map((row) => {
      let n = row.length
      while (n > 0 && row[n - 1] === '') n--
      return row.slice(0, n).join('\t')
    })
    out.push(`[${sheet.name}]\n${rows.join('\n')}`)
  }
  return out.join('\n\n')
}
