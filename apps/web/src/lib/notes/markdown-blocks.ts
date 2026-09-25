import type { Json } from '#/lib/json'

/**
 * Markdown → BlockNote blocks, on the server (SPA-66). Pure: no DOM, no
 * editor instance, no clock, no randomness — the same markdown always
 * renders the same blocks.
 *
 * Why it exists: `note.body_json` is authoritative and `note.body_md` is
 * derived from it (schema/kinds.ts), and until now the only thing that ever
 * produced either was the editor in the browser. A lane that writes a note
 * from the server — the summary first, every later note-writing lane after
 * it — has markdown from a model and nothing to turn it into blocks. Writing
 * `body_md` alone is the worst failure the note model has: `note.tsv` is
 * generated from it, so search would find a note that opens blank.
 *
 * So a note written here gets both columns from **one** source: the
 * markdown is parsed into blocks, and `body_md` is serialized back **from
 * those blocks** (`blocksToMarkdown`), never copied from the input. The two
 * cannot disagree, because one is computed from the other — exactly the
 * relationship the editor keeps on save.
 *
 * The block types are the ones a summary uses: paragraph, heading (1–6) and
 * bullet list (nested by indentation), with inline links and the bold,
 * italic and code text styles — and, since SPA-91's key terms, a GFM pipe
 * table (a header row, a `---` delimiter row, body rows), which becomes
 * BlockNote's own `table` block with the first row as its header. Anything
 * else in the markdown — a numbered list, a quote, a fence — lands as
 * paragraph text, never dropped: a line the renderer does not know is still
 * a line somebody can read and edit.
 *
 * The block shape is BlockNote's own document JSON with its default props
 * spelled out, minus `id`: BlockNote mints ids when it loads a document
 * (as it does for `createNote`'s starter block), and leaving them out is
 * what keeps this function deterministic.
 */

export type StyledText = {
  type: 'text'
  text: string
  styles: TextStyles
}

export type TextStyles = {
  bold?: true
  italic?: true
  code?: true
}

export type LinkContent = {
  type: 'link'
  href: string
  content: Array<StyledText>
}

export type InlineContent = StyledText | LinkContent

type BaseProps = {
  backgroundColor: 'default'
  textColor: 'default'
  textAlignment: 'left'
}

export type NoteBlock =
  | {
      type: 'paragraph'
      props: BaseProps
      content: Array<InlineContent>
      children: Array<NoteBlock>
    }
  | {
      type: 'heading'
      props: BaseProps & { level: HeadingLevel; isToggleable: false }
      content: Array<InlineContent>
      children: Array<NoteBlock>
    }
  | {
      type: 'bulletListItem'
      props: BaseProps
      content: Array<InlineContent>
      children: Array<NoteBlock>
    }
  | {
      type: 'table'
      props: { textColor: 'default' }
      content: TableContent
      children: Array<NoteBlock>
    }

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * BlockNote's table content, as its editor stores it: one header row, every
 * cell an explicit `tableCell` with its default props. `columnWidths` is one
 * `null` per column — unset, the width the editor picks — spelled `null`
 * rather than `undefined` because the column is JSON.
 */
export type TableContent = {
  type: 'tableContent'
  columnWidths: Array<null>
  headerRows: 1
  rows: Array<{ cells: Array<TableCell> }>
}

export type TableCell = {
  type: 'tableCell'
  props: BaseProps & { colspan: 1; rowspan: 1 }
  content: Array<InlineContent>
}

type ListItemBlock = Extract<NoteBlock, { type: 'bulletListItem' }>

const BASE_PROPS: BaseProps = {
  backgroundColor: 'default',
  textColor: 'default',
  textAlignment: 'left',
}

const HEADING_LEVELS: ReadonlyArray<HeadingLevel> = [1, 2, 3, 4, 5, 6]

// ---------- inline ----------

/** Characters a backslash may escape, per CommonMark's ASCII punctuation. */
const ESCAPABLE = /\\([\\`*_[\]()#+\-.!>{}|~])/g

const unescape = (s: string): string => s.replace(ESCAPABLE, '$1')

/**
 * The inline grammar, earliest match first: a code span, a link, a strong,
 * an emphasis. Each alternative is its own capture group so the scanner
 * knows which one matched.
 */
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[((?:\\.|[^\]\\])+)\]\(\s*<?([^()\s<>]+)>?\s*\)|(\*\*|__)(?=\S)((?:\\.|[\s\S])+?)(?<=\S)\5|(?<![\w\\*])\*(?=[^\s*])((?:\\.|[^*])+?)(?<=[^\s\\])\*(?![*\w])|(?<![\w\\])_(?=\S)((?:\\.|[^_])+?)(?<=[^\s\\])_(?!\w)/

const same = (a: TextStyles, b: TextStyles): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.code === b.code

/** Adjacent runs with the same styles are one run, as BlockNote stores them. */
function mergeRuns<T extends InlineContent>(runs: Array<T>): Array<T> {
  const out: Array<T> = []
  for (const run of runs) {
    const last = out.at(-1)
    if (
      last !== undefined &&
      last.type === 'text' &&
      run.type === 'text' &&
      same(last.styles, run.styles)
    ) {
      out[out.length - 1] = { ...last, text: last.text + run.text }
      continue
    }
    if (run.type === 'text' && run.text === '') continue
    out.push(run)
  }
  return out
}

function styled(text: string, styles: TextStyles): StyledText {
  return { type: 'text', text, styles: { ...styles } }
}

/** Inline markdown → styled text runs; links only where `links` is true. */
function parseRuns(
  source: string,
  styles: TextStyles,
  links: boolean,
): Array<InlineContent> {
  const out: Array<InlineContent> = []
  let rest = source
  while (rest.length > 0) {
    const m = INLINE.exec(rest)
    if (m === null) {
      out.push(styled(unescape(rest), styles))
      break
    }
    if (m.index > 0) out.push(styled(unescape(rest.slice(0, m.index)), styles))
    // A capture group that did not take part is `undefined` at runtime,
    // whatever `RegExpExecArray`'s `string[]` says; widened, not asserted.
    const groups: ReadonlyArray<string | undefined> = m
    const whole = m[0]
    const [, , code, linkText, href, , strong, em, underscoreEm] = groups
    if (code !== undefined) {
      out.push(styled(code, { ...styles, code: true }))
    } else if (linkText !== undefined && href !== undefined) {
      const inner = parseRuns(linkText, styles, false).filter(
        (r): r is StyledText => r.type === 'text',
      )
      if (links) out.push({ type: 'link', href, content: mergeRuns(inner) })
      else out.push(...inner)
    } else if (strong !== undefined) {
      out.push(...parseRuns(strong, { ...styles, bold: true }, links))
    } else {
      const inner = em ?? underscoreEm ?? ''
      out.push(...parseRuns(inner, { ...styles, italic: true }, links))
    }
    rest = rest.slice(m.index + whole.length)
  }
  return out
}

export function parseInline(source: string): Array<InlineContent> {
  return mergeRuns(parseRuns(source, {}, true))
}

// ---------- blocks ----------

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const FENCE = /^ {0,3}(```|~~~)/
const QUOTE = /^ {0,3}>[ \t]?/

/** Leading whitespace as columns, a tab counting four. */
const columns = (ws: string): number =>
  [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0)

const paragraph = (text: string): NoteBlock => ({
  type: 'paragraph',
  props: { ...BASE_PROPS },
  content: parseInline(text),
  children: [],
})

type OpenItem = { indent: number; block: ListItemBlock; text: string }

/**
 * A table row's cells: the outer pipes dropped, split on every `|` that is
 * not escaped. A backslash pair is kept whole — `parseInline` unescapes it —
 * so `\|` stays inside its cell and `\\` does not escape the pipe after it.
 */
function splitRow(line: string): Array<string> {
  const cells: Array<string> = []
  let cell = ''
  const body = line.trim().replace(/^\|/, '')
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\' && i + 1 < body.length) {
      cell += c + body[i + 1]
      i++
    } else if (c === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += c
  }
  // A trailing pipe closes the last cell; text after the last pipe is one.
  if (cell.trim() !== '' || !body.trimEnd().endsWith('|'))
    cells.push(cell.trim())
  return cells
}

const DELIMITER_CELL = /^:?-+:?$/

/** Whether `line` opens a table whose delimiter row is `next`. */
function tableHead(line: string, next: string | undefined): number | null {
  if (next === undefined || !/(^|[^\\])\|/.test(line)) return null
  const head = splitRow(line)
  const delim = splitRow(next)
  if (
    head.length === 0 ||
    delim.length !== head.length ||
    !delim.every((d) => DELIMITER_CELL.test(d))
  )
    return null
  return head.length
}

const cell = (text: string): TableCell => ({
  type: 'tableCell',
  props: { ...BASE_PROPS, colspan: 1, rowspan: 1 },
  content: parseInline(text),
})

/** Rows of cells → one table block, every row padded or cut to `width`. */
function table(rows: Array<Array<string>>, width: number): NoteBlock {
  return {
    type: 'table',
    props: { textColor: 'default' },
    content: {
      type: 'tableContent',
      columnWidths: Array.from({ length: width }, () => null),
      headerRows: 1,
      rows: rows.map((r) => ({
        cells: Array.from({ length: width }, (_, i) => cell(r.at(i) ?? '')),
      })),
    },
    children: [],
  }
}

/**
 * Markdown → blocks. Line-oriented: a blank line ends a paragraph, a `#`
 * line is a heading, a `-`/`*`/`+` line is a bullet whose indentation
 * against the open items above it decides its parent, a line indented
 * under an item continues that item's text, and a piped line followed by a
 * matching `---` delimiter row opens a table that runs to the first line
 * with no pipe.
 */
export function markdownToBlocks(markdown: string): Array<NoteBlock> {
  const blocks: Array<NoteBlock> = []
  let para: Array<string> = []
  let items: Array<OpenItem> = []

  const flushPara = () => {
    const text = para.join(' ').trim()
    para = []
    if (text !== '') blocks.push(paragraph(text))
  }
  const finishItems = () => {
    for (const it of items) it.block.content = parseInline(it.text.trim())
    items = []
  }
  const flushAll = () => {
    flushPara()
    finishItems()
  }

  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => raw.replace(/[ \t]+$/, ''))
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]
    if (line.trim() === '') {
      flushPara()
      continue
    }
    const width = tableHead(line, lines.at(at + 1))
    if (width !== null) {
      flushAll()
      const rows = [splitRow(line)]
      at += 2
      while (at < lines.length && lines[at].includes('|')) {
        rows.push(splitRow(lines[at]))
        at++
      }
      at--
      blocks.push(table(rows, width))
      continue
    }
    if (FENCE.test(line) || RULE.test(line)) {
      // A fence marker or a rule carries no text; what is between two
      // fences stays, as paragraph text.
      flushAll()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushAll()
      const level =
        HEADING_LEVELS.find((l) => l === heading[1].length) ?? HEADING_LEVELS[0]
      blocks.push({
        type: 'heading',
        props: { ...BASE_PROPS, level, isToggleable: false },
        content: parseInline(heading[2]),
        children: [],
      })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      flushPara()
      const indent = columns(bullet[1])
      const block: ListItemBlock = {
        type: 'bulletListItem',
        props: { ...BASE_PROPS },
        content: [],
        children: [],
      }
      // Close every open item at or deeper than this one; what is left on
      // top, if anything, is the parent.
      while (items.length > 0 && items[items.length - 1].indent >= indent) {
        const done = items.pop()
        if (done) done.block.content = parseInline(done.text.trim())
      }
      const parent = items.at(-1)
      if (parent) parent.block.children.push(block)
      else blocks.push(block)
      items.push({ indent, block, text: bullet[2] })
      continue
    }
    const open = items.at(-1)
    if (open && para.length === 0 && /^[ \t]/.test(line)) {
      // Indented under an item: a continuation of that item's text.
      open.text = `${open.text} ${line.trim()}`
      continue
    }
    finishItems()
    para.push(line.replace(QUOTE, '').trim())
  }
  flushAll()
  return blocks
}

// ---------- blocks → markdown ----------

/**
 * What `blocksToMarkdown` reads: stored JSON, whoever wrote it. Narrowed
 * field by field rather than asserted, so a block this module did not write
 * (a mention, a table, a type from a later BlockNote) degrades to its text.
 */
type JsonRecord = { [k: string]: Json }

const isRecord = (v: Json | undefined): v is JsonRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const arrayOf = (v: Json | undefined): Array<Json> =>
  Array.isArray(v) ? v : []

const stringOf = (v: Json | undefined): string =>
  typeof v === 'string' ? v : ''

/** Plain text that would otherwise read back as markdown syntax. */
const escapeText = (s: string): string => s.replace(/[\\`*_[\]]/g, '\\$&')

function wrap(text: string, styles: JsonRecord): string {
  if (text === '') return ''
  if (styles.code === true) {
    const ticks = text.includes('`') ? '``' : '`'
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
    return `${ticks}${pad}${text}${pad}${ticks}`
  }
  // Markers hug the text: surrounding spaces move outside them, or the
  // run would not read back as emphasis at all.
  const lead = /^\s*/.exec(text)?.[0] ?? ''
  const trail = /\s*$/.exec(text)?.[0] ?? ''
  const core = text.slice(lead.length, text.length - trail.length)
  if (core === '') return text
  const body = escapeText(core)
  // Bold and italic together are `**_x_**`, not `***x***`: the triple
  // reads back ambiguously, the nested pair does not.
  const out =
    styles.bold === true
      ? `**${styles.italic === true ? `_${body}_` : body}**`
      : styles.italic === true
        ? `*${body}*`
        : body
  return `${lead}${out}${trail}`
}

function inlineToMarkdown(content: Json | undefined): string {
  return arrayOf(content)
    .map((node) => {
      if (!isRecord(node)) return ''
      if (node.type === 'link') {
        const text = inlineToMarkdown(node.content)
        return `[${text}](${stringOf(node.href)})`
      }
      if (node.type === 'text') {
        const text = stringOf(node.text)
        return isRecord(node.styles) ? wrap(text, node.styles) : text
      }
      // A mention chip, or inline content from a later schema: its label,
      // so the words survive even where the chip cannot.
      if (isRecord(node.props)) return escapeText(stringOf(node.props.label))
      return escapeText(stringOf(node.text))
    })
    .join('')
}

/** Paragraph text that would open as a heading or a bullet is escaped. */
const guardLead = (s: string): string =>
  s.replace(/^(#{1,6}[ \t]|[-+][ \t])/, '\\$1')

/** A table cell's markdown: one line, and its own pipes escaped. */
const cellText = (content: Json | undefined): string =>
  inlineToMarkdown(content)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()

/**
 * A table as GFM: its first row is the header, whatever `headerRows` says —
 * GFM has no headerless table — and every row is padded to the widest. A
 * cell is a `tableCell` or, in BlockNote's older shape, the bare inline
 * array.
 */
function tableLines(content: Json | undefined): Array<string> {
  if (!isRecord(content)) return []
  const rows = arrayOf(content.rows).map((row) =>
    isRecord(row)
      ? arrayOf(row.cells).map((c) =>
          cellText(isRecord(c) ? c.content : Array.isArray(c) ? c : []),
        )
      : [],
  )
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (rows.length === 0 || width === 0) return []
  const line = (cells: Array<string>) =>
    `| ${Array.from({ length: width }, (_, i) => cells.at(i) ?? '').join(' | ')} |`
  return [
    line(rows[0]),
    line(Array.from({ length: width }, () => '---')),
    ...rows.slice(1).map(line),
  ]
}

function blockLines(block: Json, depth: number): Array<string> {
  if (!isRecord(block)) return []
  if (block.type === 'table') return tableLines(block.content)
  const pad = '  '.repeat(depth)
  const text = inlineToMarkdown(block.content)
  const children = arrayOf(block.children).flatMap((c) =>
    blockLines(c, depth + 1),
  )
  let head: string | null
  switch (block.type) {
    case 'heading': {
      const level = isRecord(block.props) ? block.props.level : undefined
      const n =
        typeof level === 'number' && level >= 1 && level <= 6 ? level : 1
      head = `${'#'.repeat(n)} ${text}`
      break
    }
    case 'bulletListItem':
      head = `- ${text}`
      break
    default:
      head = text === '' ? null : guardLead(text)
  }
  return [...(head === null ? [] : [`${pad}${head}`]), ...children]
}

/**
 * Blocks → markdown: a heading per `#` line, a bullet per `- ` line nested
 * two spaces a level, a table as GFM pipe rows, a blank line between blocks
 * and none inside a list.
 * The inverse of `markdownToBlocks` over the blocks it writes — which is
 * what makes `body_md` a function of `body_json`.
 */
export function blocksToMarkdown(blocks: ReadonlyArray<Json>): string {
  const parts: Array<{ list: boolean; lines: Array<string> }> = []
  for (const block of blocks) {
    const lines = blockLines(block, 0)
    if (lines.length === 0) continue
    const list = isRecord(block) && block.type === 'bulletListItem'
    const last = parts.at(-1)
    if (list && last?.list) last.lines.push(...lines)
    else parts.push({ list, lines })
  }
  if (parts.length === 0) return ''
  return `${parts.map((p) => p.lines.join('\n')).join('\n\n')}\n`
}

/**
 * The body a server-written note stores: the blocks, and the markdown
 * serialized from them. `bodyJson` is what the editor opens; `bodyMd` is
 * what search, embeddings and export read — and it is computed from
 * `bodyJson`, so the two describe the same note.
 */
export function noteBodyFromMarkdown(markdown: string): {
  bodyJson: Array<NoteBlock>
  bodyMd: string
} {
  const bodyJson = markdownToBlocks(markdown)
  return { bodyJson, bodyMd: blocksToMarkdown(bodyJson) }
}
