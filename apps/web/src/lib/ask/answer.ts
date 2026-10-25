import type { AskRef } from './types'

/**
 * An answer's markdown as blocks the renderer draws, with every `[ref]`
 * turned into a chip from the turn's stored refs.
 * - A claim block — a paragraph, a list item or a table — that carries no
 *   ref the turn stored is refused: it is drawn as a line saying a claim was
 *   left out, never as the claim.
 * - Exempt: headings, a lead-in ending in `:`, and a question.
 * - A bracket naming a ref the turn did not store is dropped, so a made-up
 *   citation cannot carry a claim.
 * Pure, so the dock, `/ask` and the tests read one parse.
 */

export type AnswerSegment =
  { kind: 'text'; text: string; strong: boolean } | { kind: 'ref'; ref: AskRef }

export type AnswerBlock =
  | { kind: 'heading'; segments: ReadonlyArray<AnswerSegment> }
  | { kind: 'paragraph'; segments: ReadonlyArray<AnswerSegment> }
  | { kind: 'item'; depth: number; segments: ReadonlyArray<AnswerSegment> }
  | {
      kind: 'table'
      head: ReadonlyArray<ReadonlyArray<AnswerSegment>>
      rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<AnswerSegment>>>
    }
  /** An unreferenced claim, withheld. */
  | { kind: 'refused' }

const BRACKET = /\[([^[\]\n]+)\](?!\()/g

/** The refs a bracket's inside names, or null when it is not a citation. */
function bracketRefs(inside: string): Array<string> | null {
  const parts = inside
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  if (parts.length === 0) return null
  return parts.every((p) => /^[a-z]+:\S+$/.test(p)) ? parts : null
}

/** Every ref an answer's text cites, once each, in order. */
export function citedRefs(markdown: string): Array<string> {
  const out: Array<string> = []
  for (const m of markdown.matchAll(BRACKET)) {
    for (const r of bracketRefs(m[1]) ?? []) if (!out.includes(r)) out.push(r)
  }
  return out
}

function textSegments(text: string): Array<AnswerSegment> {
  const out: Array<AnswerSegment> = []
  text.split('**').forEach((piece, i) => {
    if (piece !== '')
      out.push({ kind: 'text', text: piece, strong: i % 2 === 1 })
  })
  return out
}

/** One line of inline markdown as text and ref chips. */
export function inlineSegments(
  line: string,
  refs: ReadonlyMap<string, AskRef>,
): Array<AnswerSegment> {
  const out: Array<AnswerSegment> = []
  let at = 0
  for (const m of line.matchAll(BRACKET)) {
    const named = bracketRefs(m[1])
    if (named === null) continue
    const index = m.index
    out.push(...textSegments(line.slice(at, index).replace(/\s+$/, ' ')))
    for (const r of named) {
      const known = refs.get(r)
      if (known !== undefined) out.push({ kind: 'ref', ref: known })
    }
    at = index + m[0].length
  }
  out.push(...textSegments(line.slice(at)))
  return out
}

const hasRef = (segments: ReadonlyArray<AnswerSegment>) =>
  segments.some((s) => s.kind === 'ref')

const plain = (segments: ReadonlyArray<AnswerSegment>) =>
  segments
    .map((s) => (s.kind === 'text' ? s.text : ''))
    .join('')
    .trim()

/** A block that states no fact: a lead-in to a list, or a question. */
const exempt = (segments: ReadonlyArray<AnswerSegment>) => {
  const words = plain(segments)
  return words === '' || words.endsWith(':') || words.endsWith('?')
}

const claimOf = (
  block: Extract<AnswerBlock, { segments: ReadonlyArray<AnswerSegment> }>,
): AnswerBlock =>
  block.kind === 'heading' || hasRef(block.segments) || exempt(block.segments)
    ? block
    : { kind: 'refused' }

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/
const ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const cells = (line: string): Array<string> =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

export function answerBlocks(
  markdown: string,
  refList: ReadonlyArray<AskRef>,
  /** False while streaming: a claim's ref may not have arrived yet. */
  refuse = true,
): Array<AnswerBlock> {
  const refs = new Map(refList.map((r) => [r.ref, r]))
  const claim = (
    block: Extract<AnswerBlock, { segments: ReadonlyArray<AnswerSegment> }>,
  ): AnswerBlock => (refuse ? claimOf(block) : block)
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: Array<AnswerBlock> = []
  let para: Array<string> = []
  const flush = () => {
    if (para.length === 0) return
    const segments = inlineSegments(para.join(' '), refs)
    para = []
    if (plain(segments) === '' && !hasRef(segments)) return
    blocks.push(claim({ kind: 'paragraph', segments }))
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({
        kind: 'heading',
        segments: inlineSegments(heading[1], refs),
      })
      continue
    }
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      DELIMITER.test(lines[i + 1])
    ) {
      flush()
      const head = cells(line).map((c) => inlineSegments(c, refs))
      const rows: Array<Array<Array<AnswerSegment>>> = []
      i += 2
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(cells(lines[i]).map((c) => inlineSegments(c, refs)))
        i++
      }
      i--
      const cited = !refuse || rows.some((r) => r.some(hasRef))
      blocks.push(cited ? { kind: 'table', head, rows } : { kind: 'refused' })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      flush()
      const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2)
      blocks.push(
        claim({
          kind: 'item',
          depth,
          segments: inlineSegments(item[2], refs),
        }),
      )
      continue
    }
    para.push(line.trim())
  }
  flush()
  return blocks
}

const escapeWords = (s: string): string => s.replace(/[\\`*_[\]|]/g, '\\$&')

function segmentsMarkdown(segments: ReadonlyArray<AnswerSegment>): string {
  let out = ''
  let open: Array<string> = []
  const closeRefs = () => {
    if (open.length === 0) return
    out += ` (${[...new Set(open)].join('; ')})`
    open = []
  }
  for (const s of segments) {
    if (s.kind === 'ref') {
      open.push(escapeWords(s.ref.label))
      continue
    }
    closeRefs()
    out += s.strong ? `**${s.text}**` : s.text
  }
  closeRefs()
  return out.replace(/ +\(/g, ' (').trim()
}

/**
 * The answer as the reader saw it, as markdown a note can keep: every chip
 * written as its words, `(Acme; Deck.pdf, p.4)`, and withheld claims left
 * out.
 */
export function answerMarkdown(blocks: ReadonlyArray<AnswerBlock>): string {
  const parts: Array<string> = []
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        parts.push(`## ${segmentsMarkdown(b.segments)}`)
        break
      case 'paragraph':
        parts.push(segmentsMarkdown(b.segments))
        break
      case 'item':
        parts.push(`${'  '.repeat(b.depth)}- ${segmentsMarkdown(b.segments)}`)
        break
      case 'table': {
        const row = (rowCells: ReadonlyArray<ReadonlyArray<AnswerSegment>>) =>
          `| ${rowCells.map(segmentsMarkdown).join(' | ')} |`
        parts.push(
          [
            row(b.head),
            `| ${b.head.map(() => '---').join(' | ')} |`,
            ...b.rows.map(row),
          ].join('\n'),
        )
        break
      }
      case 'refused':
        break
    }
  }
  // Consecutive items stay one list; everything else is its own block.
  return parts
    .reduce<Array<string>>((acc, p) => {
      const last = acc.at(-1)
      if (last !== undefined && /^\s*- /.test(p) && /^\s*- /m.test(last))
        acc[acc.length - 1] = `${last}\n${p}`
      else acc.push(p)
      return acc
    }, [])
    .join('\n\n')
}
