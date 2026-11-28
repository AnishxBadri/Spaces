import { citedRefs, inlineSegments } from '#/lib/ask/answer'
import type { AnswerSegment } from '#/lib/ask/answer'
import type { AskRef } from '#/lib/ask/types'

/**
 * A meeting's brief, read into the four parts the card draws. Pure and
 * client-safe, so the card, the stream and the tests read one parse.
 * - The model is asked for one line per part, led by its label and a colon.
 *   Markdown dressing around a label (`## Who`, `**Deal:**`, `- Since:`) is
 *   read through.
 * - Text before the first label is the lead. An answer with no label at all
 *   is all lead, so it still shows whole.
 * - A part named twice gathers both; one never written is left out.
 */

export const BRIEF_PARTS = ['Who', 'Deal', 'Last time', 'Since'] as const
export type BriefPartLabel = (typeof BRIEF_PARTS)[number]

export type BriefPart = { label: BriefPartLabel; text: string }
export type ParsedBrief = { lead: string; parts: ReadonlyArray<BriefPart> }

// The label, then a colon and the part's text; or the label alone on its
// line, a heading with the text under it.
const LABELLED =
  /^[\s#>*_-]*(who|deal|last time|since)[\s*_]*(?::[\s*_]*(.*))?$/i

const labelOf = (word: string): BriefPartLabel | undefined =>
  BRIEF_PARTS.find((l) => l.toLowerCase() === word.toLowerCase())

export function parseBrief(text: string): ParsedBrief {
  const lead: Array<string> = []
  const parts = new Map<BriefPartLabel, Array<string>>()
  let current: Array<string> = lead
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const m = LABELLED.exec(line)
    const label = m === null ? undefined : labelOf(m[1])
    if (m !== null && label !== undefined) {
      current = parts.get(label) ?? []
      parts.set(label, current)
      const rest = (m.at(2) ?? '').trim()
      if (rest !== '') current.push(rest)
    } else if (line !== '') current.push(line.replace(/^[-*]\s+/, ''))
  }
  return {
    lead: lead.join(' '),
    parts: BRIEF_PARTS.flatMap((label) => {
      const lines = parts.get(label)
      return lines === undefined || lines.length === 0
        ? []
        : [{ label, text: lines.join(' ') }]
    }),
  }
}

/**
 * The number each cited source carries, `[1]` onwards, in the order the
 * brief first cites it. Only a source the brief holds is numbered.
 */
export function citationNumbers(
  body: string,
  refs: ReadonlyArray<AskRef>,
): Map<string, number> {
  const known = new Set(refs.map((r) => r.ref))
  const out = new Map<string, number>()
  for (const r of citedRefs(body))
    if (known.has(r) && !out.has(r)) out.set(r, out.size + 1)
  return out
}

/**
 * The sources a brief still arriving cites: named by their kind until the
 * finished brief labels them, as Ask's streaming answer does.
 */
export function streamingRefs(body: string): Array<AskRef> {
  return citedRefs(body).map((r) => ({
    ref: r,
    label: r.slice(0, r.indexOf(':')),
    href: null,
    entityId: null,
  }))
}

/** A brief cut mid-citation drops the open bracket until it closes. */
export const settledText = (text: string): string =>
  text.replace(/\[[^\]\n]*$/, '')

/** One part's text as words and citations. */
export function briefSegments(
  text: string,
  refs: ReadonlyArray<AskRef>,
): Array<AnswerSegment> {
  return inlineSegments(text, new Map(refs.map((r) => [r.ref, r])))
}
