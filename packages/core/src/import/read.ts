import type { Zip } from '../documents/ooxml'
import { allRuns, decodeXml, entry, numbered, unzip } from '../documents/ooxml'

/**
 * The spreadsheet reader (SPA-163, import-1): CSV, TSV and XLSX bytes into
 * one cell grid, so every later import step — staging, mapping, coercion,
 * resolve — reads the same shape whatever the user uploaded. Pure: bytes in,
 * strings out, no database, no dependency beyond the fflate the xlsx text
 * path already carried. `extract.ts`'s `fromXlsx` reads through
 * `readXlsx` here, so the repo keeps one xlsx parser.
 *
 * Cells are strings, verbatim. The one interpretation the reader makes is a
 * date: a numeric xlsx cell whose style is a date format comes back as
 * `YYYY-MM-DD`, because the serial ("45000") is all the cell holds and the
 * style is the only place the intent lives — no later step can recover it.
 */

export type Sheet = {
  /** The sheet's real name; a CSV's is its filename without the extension. */
  name: string
  /**
   * Index into `rows` of the detected header: the first row with no blank
   * and no duplicate cell. `null` when no row qualifies — every row is then
   * data and the caller decides what the columns are.
   */
  headerRow: number | null
  /**
   * Every non-blank row, padded to the sheet's width so the grid is
   * rectangular and column `i` means the same thing on every row.
   */
  rows: Array<Array<string>>
}

export type Grid = { sheets: Array<Sheet> }

/** Data rows per sheet an import takes. Above it the file is refused, never truncated. */
export const MAX_IMPORT_ROWS = 20_000

/** The reader will not produce a grid from this file; `message` says why, naming it. */
export class GridRefused extends Error {
  override name = 'GridRefused'
  constructor(
    readonly filename: string,
    message: string,
  ) {
    super(message)
  }
}

export class RowCapExceeded extends GridRefused {
  override name = 'RowCapExceeded'
  constructor(
    filename: string,
    readonly sheet: string,
    readonly rows: number,
  ) {
    super(
      filename,
      `${filename} has ${rows.toLocaleString('en-US')} data rows on sheet "${sheet}" — an import takes at most ${MAX_IMPORT_ROWS.toLocaleString('en-US')}. Split the file and import each part.`,
    )
  }
}

/**
 * The format is chosen by content first and extension second, never by MIME
 * (which the signature does not even take): a zip is a workbook whatever it
 * is called, an OLE file is a legacy .xls whatever it is called, and
 * anything else that decodes as text is delimited.
 */
export function readGrid(bytes: Uint8Array, filename: string): Grid {
  const sheets =
    kindOf(bytes, filename) === 'xlsx'
      ? xlsxSheets(bytes, filename)
      : [delimitedSheet(bytes, filename)]

  for (const sheet of sheets) {
    const data =
      sheet.rows.length - (sheet.headerRow === null ? 0 : sheet.headerRow + 1)
    if (data > MAX_IMPORT_ROWS) {
      throw new RowCapExceeded(filename, sheet.name, data)
    }
  }
  return { sheets }
}

// ---------- format ----------

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]
const XLSX_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xltx'])

function kindOf(bytes: Uint8Array, filename: string): 'xlsx' | 'delimited' {
  if (startsWith(bytes, ZIP_MAGIC)) return 'xlsx'
  if (startsWith(bytes, OLE_MAGIC)) {
    throw new GridRefused(
      filename,
      `${filename} is a legacy Excel (.xls) workbook — save it as .xlsx or .csv and upload that.`,
    )
  }
  const ext = extension(filename)
  if (XLSX_EXTENSIONS.has(ext)) {
    throw new GridRefused(
      filename,
      `${filename} is named .${ext} but is not an Excel workbook.`,
    )
  }
  if (looksBinary(bytes)) {
    throw new GridRefused(
      filename,
      `${filename} is not a spreadsheet — upload a .csv, .tsv or .xlsx file.`,
    )
  }
  return 'delimited'
}

function startsWith(bytes: Uint8Array, magic: Array<number>): boolean {
  return magic.every((b, i) => bytes[i] === b)
}

function extension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** NUL bytes in the head of a file no text encoding we read would produce. */
function looksBinary(bytes: Uint8Array): boolean {
  if (isUtf16Le(bytes)) return false
  return bytes.subarray(0, 1024).includes(0)
}

function isUtf16Le(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xfe
}

// ---------- the grid ----------

function toSheet(name: string, raw: Array<Array<string>>): Sheet {
  const rows = raw.filter((r) => r.some((c) => c.trim() !== ''))
  const width = Math.max(0, ...rows.map(filledWidth))
  const padded = rows.map((r) => {
    const row = r.slice(0, width)
    while (row.length < width) row.push('')
    return row
  })
  return { name, headerRow: detectHeader(padded), rows: padded }
}

/** Length of a row with its trailing blank cells dropped. */
function filledWidth(row: Array<string>): number {
  let n = row.length
  while (n > 0 && row[n - 1].trim() === '') n--
  return n
}

/**
 * The first row with no blank and no duplicate cell — deterministic, no AI.
 * The grid is rectangular by then, so a title row ("Portfolio — Q3") that
 * fills one cell of a five-column sheet has four blanks and is skipped.
 * Duplicates compare trimmed and case-insensitive: "Name" and "name " would
 * map onto the same attribute, so they cannot both be headers.
 */
function detectHeader(rows: Array<Array<string>>): number | null {
  const index = rows.findIndex((row) => {
    const seen = new Set<string>()
    for (const cell of row) {
      const key = cell.trim().toLowerCase()
      if (key === '' || seen.has(key)) return false
      seen.add(key)
    }
    return row.length > 0
  })
  return index === -1 ? null : index
}

// ---------- delimited text ----------

const DELIMITERS = [',', ';', '\t']

function delimitedSheet(bytes: Uint8Array, filename: string): Sheet {
  const text = decodeText(bytes)
  const delimiter = extension(filename) === 'tsv' ? '\t' : sniffDelimiter(text)
  return toSheet(baseName(filename), parseDelimited(text, delimiter))
}

function baseName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * UTF-8 with its BOM dropped (TextDecoder drops it; the replace is the
 * belt to that brace), or UTF-16LE when the file says so — Excel's "Unicode
 * text" export is tab-delimited UTF-16LE.
 */
function decodeText(bytes: Uint8Array): string {
  const text = isUtf16Le(bytes)
    ? new TextDecoder('utf-16le').decode(bytes.subarray(2))
    : new TextDecoder('utf-8').decode(bytes)
  return text.replace(/^\uFEFF/, '')
}

/**
 * Which of `,` `;` and tab occurs most, outside quotes, on the header line
 * (the first non-blank line). A European export is semicolon-delimited
 * because the comma is its decimal mark; asking the user which is an
 * onboarding failure. A tie, or a single-column file, reads as comma.
 */
export function sniffDelimiter(text: string): string {
  const counts = new Map(DELIMITERS.map((d) => [d, 0]))
  let quoted = false
  let started = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (quoted) continue
    if (ch === '\n' || ch === '\r') {
      if (started) break
      continue
    }
    if (ch.trim() !== '') started = true
    const n = counts.get(ch)
    if (n !== undefined) counts.set(ch, n + 1)
  }
  let best = ','
  for (const d of DELIMITERS) {
    if ((counts.get(d) ?? 0) > (counts.get(best) ?? 0)) best = d
  }
  return best
}

/**
 * RFC 4180, hand-rolled: a field opening with `"` runs to the matching quote
 * and may carry the delimiter, `""` (one literal quote) and newlines. CRLF,
 * LF and a lone CR all end a record, and a newline inside a quoted field is
 * stored as LF — so a CRLF file and its LF twin produce identical grids.
 * Lenient where the RFC is silent: a quote in the middle of an unquoted field
 * is literal, and an unterminated quote runs to the end of the file.
 */
export function parseDelimited(
  text: string,
  delimiter: string,
): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ''
  let quoted = false
  let fieldStart = true
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
    fieldStart = true
  }

  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          quoted = false
          i += 1
        }
      } else if (ch === '\r') {
        field += '\n'
        i += text[i + 1] === '\n' ? 2 : 1
      } else {
        field += ch
        i += 1
      }
      continue
    }
    if (ch === '"' && fieldStart) {
      quoted = true
      fieldStart = false
      i += 1
    } else if (ch === delimiter) {
      endField()
      i += 1
    } else if (ch === '\n' || ch === '\r') {
      endField()
      rows.push(row)
      row = []
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      field += ch
      fieldStart = false
      i += 1
    }
  }
  if (!fieldStart || row.length > 0) {
    endField()
    rows.push(row)
  }
  return rows
}

// ---------- xlsx ----------

/**
 * Every worksheet in tab order, under its real name. Uncapped: this is what
 * `fromXlsx` composes for search text, where a 50,000-row sheet is a
 * perfectly good document; the import cap is `readGrid`'s.
 */
export function readXlsx(bytes: Uint8Array): Array<Sheet> {
  const zip = unzip(bytes)
  const sharedXml = entry(zip, 'xl/sharedStrings.xml')
  const stylesXml = entry(zip, 'xl/styles.xml')
  const workbook = entry(zip, 'xl/workbook.xml') ?? ''
  const context: CellContext = {
    shared: sharedXml ? sharedStrings(sharedXml) : [],
    dateStyles: stylesXml ? dateStyles(stylesXml) : new Set(),
    date1904: /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook),
  }
  return worksheets(zip).map((sheet) =>
    toSheet(sheet.name, worksheetRows(sheet.xml, context)),
  )
}

function xlsxSheets(bytes: Uint8Array, filename: string): Array<Sheet> {
  let sheets: Array<Sheet>
  try {
    sheets = readXlsx(bytes)
  } catch (err) {
    throw new GridRefused(
      filename,
      `${filename} could not be read as a workbook: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (sheets.length === 0) {
    throw new GridRefused(filename, `${filename} contains no worksheets.`)
  }
  return sheets
}

type CellContext = {
  shared: Array<string>
  /** Indexes into styles.xml's cellXfs whose number format is a date. */
  dateStyles: Set<number>
  date1904: boolean
}

function sharedStrings(xml: string): Array<string> {
  // One <si> may hold many <t> runs (rich text) — concatenate, don't take
  // the first, or "Series A" arrives as "Series". Phonetic guides (<rPh>)
  // are annotations, not the value.
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    allRuns(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't').join(''),
  )
}

/**
 * The worksheets in the workbook's tab order, named through the workbook
 * relationships (rId → part path). Sheet names carry meaning ("Cap Table
 * (post)") — dropping them for sheet1/sheet2 throws away the most searchable
 * string in the file. A workbook with no readable manifest falls back to the
 * numbered parts as "Sheet N".
 */
function worksheets(zip: Zip): Array<{ name: string; xml: string }> {
  const workbook = entry(zip, 'xl/workbook.xml')
  const rels = entry(zip, 'xl/_rels/workbook.xml.rels')
  const out: Array<{ name: string; xml: string }> = []

  if (workbook && rels) {
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
      const xml = path ? entry(zip, path) : undefined
      if (name !== undefined && xml !== undefined) {
        out.push({ name: decodeXml(name), xml })
      }
    }
  }
  if (out.length > 0) return out

  return numbered(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((s) => ({
    name: `Sheet ${s.n}`,
    xml: s.xml,
  }))
}

/**
 * Rows of cells, each cell placed at the column its `r` reference names:
 * xlsx omits empty cells, so reading them in document order would slide
 * every value after a gap one column left. Self-closing `<c/>` and `<row/>`
 * are matched as such — a lazy match to the next close tag would hand one
 * cell's value to its empty neighbour.
 */
function worksheetRows(
  xml: string,
  context: CellContext,
): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = row[1]
    if (!body) continue
    const cells: Array<string> = []
    for (const cell of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = columnIndex(cell[1]) ?? cells.length
      while (cells.length < col) cells.push('')
      cells[col] = cellValue(cell[1], cell.at(2) ?? '', context)
    }
    rows.push(cells)
  }
  return rows
}

/** `r="AB12"` → 27. Undefined when the cell carries no reference. */
function columnIndex(attrs: string): number | undefined {
  const letters = attrs.match(/\br="([A-Z]+)\d*"/)?.[1]
  if (!letters) return undefined
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function cellValue(attrs: string, inner: string, context: CellContext): string {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1]
  const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
  switch (type) {
    case 's': {
      const idx = Number(raw)
      return (Number.isInteger(idx) ? context.shared.at(idx) : undefined) ?? ''
    }
    case 'inlineStr':
      return allRuns(inner, 't').join('')
    case 'b':
      // What the user sees in the cell, and what the same sheet saved as
      // CSV says.
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : ''
    case 'd':
      // Strict OOXML stores dates as ISO 8601 text; the day is the value.
      return decodeXml(raw ?? '').slice(0, 10)
    case 'str':
    case 'e':
      return decodeXml(raw ?? '')
    default: {
      const value = decodeXml(raw ?? '')
      const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0)
      if (!context.dateStyles.has(style)) return value
      return serialToIsoDate(value, context.date1904) ?? value
    }
  }
}

// ---------- dates ----------

/**
 * The built-in number formats that render a date (ECMA-376 §18.8.30, plus
 * the CJK locale dates at 27–31, 34–36 and 50–58). Time-only formats
 * (18–21, 45–47) are deliberately absent: a time of day is not a date.
 */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55,
  56, 57, 58,
])

/** cellXfs indexes whose numFmtId is a built-in or custom date format. */
function dateStyles(xml: string): Set<number> {
  const custom = new Map<number, string>()
  for (const m of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = Number(m[1].match(/\bnumFmtId="(\d+)"/)?.[1])
    const code = m[1].match(/\bformatCode="([^"]*)"/)?.[1]
    if (Number.isInteger(id) && code !== undefined) {
      custom.set(id, decodeXml(code))
    }
  }

  const out = new Set<number>()
  const xfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? ''
  let index = 0
  for (const m of xfs.matchAll(/<xf\b([^>]*?)\/?>/g)) {
    const id = Number(m[1].match(/\bnumFmtId="(\d+)"/)?.[1] ?? 0)
    const code = custom.get(id)
    if (code === undefined ? BUILTIN_DATE_FORMATS.has(id) : isDateFormat(code))
      out.add(index)
    index++
  }
  return out
}

/**
 * A custom format code renders a date when its positive-number section,
 * with quoted literals, escapes, fill/padding and bracketed tokens
 * ([Red], [$-409], [h]) removed, has a year or day token — or a month token
 * with no hour or second beside it, since `m` next to `h`/`s` is minutes.
 */
export function isDateFormat(code: string): boolean {
  const bare = (code.split(';')[0] ?? '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
  if (/[yd]/.test(bare)) return true
  return bare.includes('m') && !/[hs]/.test(bare)
}

const DAY_MS = 86_400_000
/** 9999-12-31 in the 1900 system — past it a Date cannot print four digits. */
const MAX_SERIAL = 2_958_465

/**
 * An Excel serial as `YYYY-MM-DD`, the time of day dropped. The 1900 system
 * counts from 1899-12-31 and keeps Lotus's phantom 1900-02-29 at 60, so
 * from 61 on the epoch is effectively 1899-12-30 (45000 → 2023-03-15). The
 * 1904 system counts from 1904-01-01. Null for anything that is not a
 * non-negative serial a calendar can print.
 */
export function serialToIsoDate(
  value: string,
  date1904 = false,
): string | null {
  const serial = value.trim() === '' ? NaN : Number(value)
  if (!Number.isFinite(serial) || serial < 0 || serial > MAX_SERIAL) {
    return null
  }
  // Round to the millisecond first so 45000.99999999999 is not a day early.
  const days = Math.floor(Math.round(serial * DAY_MS) / DAY_MS)
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : days <= 60
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30)
  return new Date(epoch + days * DAY_MS).toISOString().slice(0, 10)
}
