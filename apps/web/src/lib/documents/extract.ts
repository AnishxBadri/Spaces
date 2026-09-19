import { strFromU8, unzipSync } from 'fflate'

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

async function fromPdf(bytes: Uint8Array): Promise<string> {
  // Dynamic import: unpdf pulls in a pdf.js build, and the web process must
  // never load it — extraction is the worker's job.
  const { extractText, getDocumentProxy } = await import('unpdf')
  // getDocumentProxy transfers the buffer, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const result = await extractText(pdf, { mergePages: true })
  // mergePages narrows this to a string, but the runtime shape has changed
  // across unpdf versions — widen and handle both rather than trust it.
  const text: string | Array<string> = result.text
  return Array.isArray(text) ? text.join('\n\n') : text
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
  const zip = unzipSync(bytes)
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
 */
function fromXlsx(bytes: Uint8Array): string {
  const zip = unzipSync(bytes)
  const sharedXml = entry(zip, 'xl/sharedStrings.xml')
  const shared = sharedXml ? sharedStrings(sharedXml) : []
  const names = sheetNames(zip)

  const out: Array<string> = []
  for (const sheet of numbered(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/)) {
    const rows = worksheetRows(sheet.xml, shared)
    if (rows.length === 0) continue
    const title = names.get(sheet.path) ?? `Sheet ${sheet.n}`
    out.push(`[${title}]\n${rows.map((r) => r.join('\t')).join('\n')}`)
  }
  return out.join('\n\n')
}

function sharedStrings(xml: string): Array<string> {
  // One <si> may hold many <t> runs (rich text) — concatenate, don't take
  // the first, or "Series A" arrives as "Series".
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    ooxmlRuns(m[1], 't').join(''),
  )
}

/** rId → sheet name, resolved through the workbook relationships. */
function sheetNames(zip: Zip): Map<string, string> {
  const result = new Map<string, string>()
  const workbook = entry(zip, 'xl/workbook.xml')
  const rels = entry(zip, 'xl/_rels/workbook.xml.rels')
  if (!workbook || !rels) return result

  const target = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = m[1].match(/\bId="([^"]+)"/)?.[1]
    const path = m[1].match(/\bTarget="([^"]+)"/)?.[1]
    if (id && path) {
      target.set(id, `xl/${path.replace(/^\/?(xl\/)?/, '')}`)
    }
  }
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const name = m[1].match(/\bname="([^"]*)"/)?.[1]
    const rid = m[1].match(/r:id="([^"]+)"/)?.[1]
    const path = rid ? target.get(rid) : undefined
    if (name && path) result.set(path, decodeXml(name))
  }
  return result
}

function worksheetRows(
  xml: string,
  shared: Array<string>,
): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Array<string> = []
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const type = cell[1].match(/\bt="([^"]+)"/)?.[1]
      if (type === 's') {
        const idx = Number(cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1])
        cells.push((Number.isInteger(idx) ? shared.at(idx) : undefined) ?? '')
      } else if (type === 'inlineStr') {
        cells.push(ooxmlRuns(cell[2], 't').join(''))
      } else {
        // Numbers, dates (serials), booleans: the raw value. Formatting is
        // presentation; search wants the number.
        cells.push(decodeXml(cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ''))
      }
    }
    if (cells.some((c) => c !== '')) rows.push(cells)
  }
  return rows
}

// ---------- shared OOXML helpers ----------

type Zip = Record<string, Uint8Array>
type ZipEntry = { path: string; n: number; xml: string }

/** Decoded zip member, or undefined when the archive doesn't carry it. */
function entry(zip: Zip, path: string): string | undefined {
  const bytes = Object.hasOwn(zip, path) ? zip[path] : undefined
  return bytes ? strFromU8(bytes) : undefined
}

/**
 * Zip entries matching a numbered-file pattern, in numeric order — slide10
 * sorts after slide9, which a lexical sort gets wrong.
 */
function numbered(zip: Zip, pattern: RegExp): Array<ZipEntry> {
  return Object.entries(zip)
    .map(([path, bytes]) => {
      const m = path.match(pattern)
      return m ? { path, n: Number(m[1]), xml: strFromU8(bytes) } : null
    })
    .filter((x): x is ZipEntry => x !== null)
    .sort((a, b) => a.n - b.n)
}

/** Text of every <tag>…</tag> run, entity-decoded. */
function ooxmlRuns(xml: string, tag: string): Array<string> {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  return [...xml.matchAll(pattern)]
    .map((m) => decodeXml(m[1]))
    .filter((t) => t.trim() !== '')
}

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(parseInt(code.slice(2), 16))
    }
    if (code.startsWith('#')) {
      return String.fromCodePoint(Number(code.slice(1)))
    }
    return ENTITIES.get(code) ?? whole
  })
}
