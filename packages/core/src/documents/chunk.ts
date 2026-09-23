import type { Format } from './extract'

/**
 * `chunk(text, format)` — a document's extracted text cut into the retrieval
 * grain (docs/spec-ai-substrate.md §9; SPA-121, ai-10b). Pure: no database,
 * no clock, no model — the embed program (`apps/web/src/lib/ai/embed-document.ts`)
 * is the only caller that does I/O with the result.
 *
 * The cut follows the structure `extract.ts` leaves in the text:
 *
 * - **PDF / PPTX — by page.** `[Page N]` / `[Slide N]` markers (ai-10a) each
 *   open one chunk, however short the page is: a 40-slide deck is 40 chunks,
 *   never one 40-slide blob, because the slide is what a citation names.
 *   `page` is N — the real number, so a skipped scan page is not renumbered.
 * - **XLSX — by sheet, then row blocks.** Each `[Sheet name]` opens a sheet;
 *   rows are packed into blocks, and every block after the first repeats the
 *   marker and the sheet's first row, so "row 212 of the cap table" still
 *   says which sheet and which columns it is. `page` is the sheet's 1-based
 *   position in the text.
 * - **DOCX — by heading.** mammoth's raw text keeps no heading styles, so a
 *   heading is read off the paragraph: one line, short, no sentence
 *   punctuation at its end. Headings are *preferred boundaries*: consecutive
 *   short sections are packed together up to the size limit and a chunk is
 *   only ever closed at one. A false positive (a bullet with no full stop)
 *   costs a slightly earlier boundary, nothing more. `page` is null.
 * - **Text (and a PDF extracted before ai-10a, with no markers)** — the
 *   paragraph packing DOCX uses, with no headings.
 *
 * Size: ~400–600 tokens, estimated at a fixed {@link CHARS_PER_TOKEN} characters
 * per token (no tokenizer — the estimate only has to keep a chunk inside
 * every provider's input limit and near the spec's range). A unit longer
 * than {@link MAX_CHARS} is split at a line break, else a space, and the next
 * piece re-reads the last ≤ {@link OVERLAP_CHARS} characters of the one before
 * — overlap is only added where the boundary is arbitrary; a page, a sheet
 * or a heading is a real boundary and carries none.
 *
 * `idx` is 0-based and dense, the `chunk.idx` the unique index
 * `(entity_id, source_kind, source_key, idx)` keys and the `#n` in
 * `doc:<id>#n` refs.
 */

export type TextChunk = {
  idx: number
  text: string
  /** 1-based page / slide (PDF, PPTX) or sheet position (XLSX); else null. */
  page: number | null
}

/** The estimate: a fixed four characters per token. */
export const CHARS_PER_TOKEN = 4
/** ~600 tokens: no chunk is longer than this. */
export const MAX_CHARS = 600 * CHARS_PER_TOKEN
/** ~50 tokens re-read across an arbitrary cut. */
export const OVERLAP_CHARS = 50 * CHARS_PER_TOKEN

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

type Section = {
  /** The marker or heading line that opened it; null before the first. */
  head: string | null
  body: string
  page: number | null
}

const PAGE_MARKER = /^\[Page (\d+)\]$/
const SLIDE_MARKER = /^\[Slide (\d+)\]$/
const SHEET_MARKER = /^\[(.+)\]$/

export function chunk(text: string, format: Format): Array<TextChunk> {
  const clean = text.trim()
  if (clean === '') return []
  const pieces = cut(clean, format)
  return pieces
    .filter((p) => p.text.trim() !== '')
    .map((p, idx) => ({ idx, text: p.text, page: p.page }))
}

function cut(
  text: string,
  format: Format,
): Array<{ text: string; page: number | null }> {
  switch (format) {
    case 'pdf':
    case 'pptx': {
      const sections = byMarker(
        text,
        format === 'pdf' ? PAGE_MARKER : SLIDE_MARKER,
        (m) => Number(m[1]),
      )
      // No marker at all: text extracted before ai-10a. Paragraphs, then.
      if (sections.every((s) => s.head === null))
        return packed(paragraphs(text))
      return sections.flatMap((s) => withHead(s.head, s.body, s.page))
    }
    case 'xlsx': {
      let ordinal = 0
      const sections = byMarker(text, SHEET_MARKER, () => ++ordinal)
      return sections.flatMap((s) => rowBlocks(s))
    }
    case 'docx':
      return packed(headingSections(text))
    case 'text':
      return packed(paragraphs(text))
  }
}

/**
 * Split on marker lines. A marker counts only at the start of the text or
 * after a blank line — the shape `extract.ts` joins pages and sheets in — so
 * a spreadsheet row that happens to read `[x]` stays a row.
 */
function byMarker(
  text: string,
  marker: RegExp,
  pageOf: (m: RegExpMatchArray) => number,
): Array<Section> {
  const sections: Array<Section> = []
  let current: Section = { head: null, body: '', page: null }
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const m = i === 0 || lines[i - 1] === '' ? line.match(marker) : null
    if (m) {
      if (current.head !== null || current.body.trim() !== '')
        sections.push(current)
      current = { head: line, body: '', page: pageOf(m) }
      return
    }
    current.body = current.body === '' ? line : `${current.body}\n${line}`
  })
  sections.push(current)
  return sections
    .map((s) => ({ ...s, body: s.body.trim() }))
    .filter((s) => s.head !== null || s.body !== '')
}

/** A unit that keeps its head line on every piece it is split into. */
function withHead(
  head: string | null,
  body: string,
  page: number | null,
): Array<{ text: string; page: number | null }> {
  const lead = head === null ? '' : `${head}\n`
  if (lead.length + body.length <= MAX_CHARS)
    return [{ text: `${lead}${body}`.trim(), page }]
  return split(body, MAX_CHARS - lead.length).map((p) => ({
    text: `${lead}${p}`,
    page,
  }))
}

/**
 * One sheet → row blocks. Rows are never cut unless one row alone is over
 * the limit; blocks after the first repeat the marker and the first row.
 */
function rowBlocks(s: Section): Array<{ text: string; page: number | null }> {
  const lead = s.head ?? ''
  const whole = lead === '' ? s.body : `${lead}\n${s.body}`
  if (whole.length <= MAX_CHARS) return [{ text: whole.trim(), page: s.page }]
  const rows = s.body.split('\n')
  const header = rows[0]
  // What every block after the first opens with: the marker, and the header
  // row unless it is so wide it would crowd out the rows it labels.
  const carry = [lead, header.length <= MAX_CHARS / 2 ? header : '']
    .filter((x) => x !== '')
    .join('\n')
  const out: Array<{ text: string; page: number | null }> = []
  let block = lead
  let hasRows = false
  const join = (a: string, b: string) => (a === '' ? b : `${a}\n${b}`)
  const flush = () => {
    out.push({ text: block, page: s.page })
    block = carry
    hasRows = false
  }
  for (const row of rows) {
    if (join(block, row).length <= MAX_CHARS) {
      block = join(block, row)
      hasRows = true
      continue
    }
    if (hasRows) flush()
    if (join(block, row).length <= MAX_CHARS) {
      block = join(block, row)
      hasRows = true
      continue
    }
    // One row over the limit on its own: split it, each piece led by the
    // carry like any other block.
    const room = MAX_CHARS - (carry === '' ? 0 : carry.length + 1)
    for (const piece of split(row, room))
      out.push({ text: join(carry, piece), page: s.page })
    block = carry
  }
  if (hasRows) out.push({ text: block, page: s.page })
  return out
}

/** Blank-line-separated paragraphs as head-less sections. */
function paragraphs(text: string): Array<Section> {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((body) => ({ head: null, body, page: null }))
}

/**
 * A DOCX paragraph read as a heading: a single line of at most 80
 * characters and 12 words, starting with a letter or digit and ending in
 * neither sentence punctuation nor a closing quote or bracket.
 */
export function looksLikeHeading(paragraph: string): boolean {
  const p = paragraph.trim()
  if (p === '' || p.includes('\n') || p.length > 80) return false
  if (p.split(/\s+/).length > 12) return false
  if (!/^[\p{L}\p{N}]/u.test(p)) return false
  return !/[.,;:!?…"'”’)\]]$/.test(p)
}

/** DOCX text → sections, each opened by a heading paragraph. */
function headingSections(text: string): Array<Section> {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  const sections: Array<Section> = []
  let current: Section = { head: null, body: '', page: null }
  paras.forEach((p, i) => {
    // The last paragraph heads nothing, so it is body whatever it looks like.
    if (i < paras.length - 1 && looksLikeHeading(p)) {
      if (current.head !== null || current.body !== '') sections.push(current)
      current = { head: p, body: '', page: null }
      return
    }
    current.body = current.body === '' ? p : `${current.body}\n\n${p}`
  })
  sections.push(current)
  return sections.filter((s) => s.head !== null || s.body !== '')
}

/**
 * Pack sections greedily into chunks of at most MAX_CHARS, closing a chunk
 * only between sections. A section over the limit on its own is split, each
 * piece led by its heading.
 */
function packed(
  sections: Array<Section>,
): Array<{ text: string; page: number | null }> {
  const out: Array<{ text: string; page: number | null }> = []
  let current = ''
  const flush = () => {
    if (current !== '') out.push({ text: current, page: null })
    current = ''
  }
  for (const s of sections) {
    const whole = s.head === null ? s.body : `${s.head}\n${s.body}`.trim()
    if (whole.length > MAX_CHARS) {
      flush()
      out.push(...withHead(s.head, s.body, null))
      continue
    }
    const next = current === '' ? whole : `${current}\n\n${whole}`
    if (next.length <= MAX_CHARS) {
      current = next
      continue
    }
    flush()
    current = whole
  }
  flush()
  return out
}

/**
 * Cut `body` into pieces of at most `budget` characters, preferring a line
 * break in the back half of the window, then a space, then a hard cut. Each
 * piece after the first starts up to OVERLAP_CHARS before the previous one
 * ended, at a word boundary.
 */
function split(body: string, budget: number): Array<string> {
  const room = Math.max(budget, 1)
  if (body.length <= room) return [body]
  const out: Array<string> = []
  let start = 0
  while (start < body.length) {
    let end = Math.min(start + room, body.length)
    if (end < body.length) {
      const window = body.slice(start, end)
      const nl = window.lastIndexOf('\n')
      const sp = window.lastIndexOf(' ')
      const at = nl > room / 2 ? nl : sp > room / 2 ? sp : -1
      if (at > 0) end = start + at
    }
    const piece = body.slice(start, end).trim()
    if (piece !== '') out.push(piece)
    if (end >= body.length) break
    const back = Math.max(end - OVERLAP_CHARS, start + 1)
    const ws = body.slice(back, end).search(/\s/)
    start = ws === -1 ? end : back + ws + 1
  }
  return out
}
