import { renderWikiLinks } from './wiki-link'

/**
 * The editor's trailing `Mentions: [[…]]` line — bookkeeping, not prose.
 * Only a trailing line is cut, so a sentence that says "Mentions:" mid-note
 * keeps its words.
 */
const MENTIONS_TRAILER = /(?:^|\n)[ \t]*Mentions:[^\n]*\s*$/

export type ExcerptOptions = {
  /** Cut to this many characters, counted on the rendered text. */
  max?: number
  /** `text` is a whole note body: drop its trailing `Mentions:` line first. */
  noteBody?: boolean
}

/**
 * The one way a reader's excerpt is built from a note body, document text or
 * a search snippet.
 * - Every wiki link, whole or cut at an edge, reads as its label: no excerpt
 *   prints `[[` or `entity:`.
 * - Whitespace collapses to single spaces; `max` cuts after both.
 */
export function excerpt(text: string, options: ExcerptOptions = {}): string {
  const body = options.noteBody ? text.replace(MENTIONS_TRAILER, '') : text
  const flat = renderWikiLinks(body).replace(/\s+/g, ' ').trim()
  return options.max === undefined ? flat : flat.slice(0, options.max)
}
