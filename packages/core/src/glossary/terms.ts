import { buildAutomaton, findMatches } from './aho-corasick'
import type { Automaton, Pattern } from './aho-corasick'

/**
 * The one way a term set becomes a matcher (SPA-34). Two consumers read it:
 * the editor decoration (client, `components/editor/glossary-decoration.ts`)
 * and the server link sync (`lib/glossary/link-terms.ts`), which writes
 * `link(note|document → term, mentions, extracted)`. Both call
 * `termAutomaton`, so the rule "a term that highlights in the editor links
 * in the graph" is one function, not two that happen to agree.
 *
 * Pure: no drizzle, no React — the decoration ships to the browser.
 */

/** What a matcher needs of a term. The decoration's row carries more. */
export type TermSource = {
  id: string
  name: string
  aliases: ReadonlyArray<string>
}

/** Name and every alias, each pointing at the term's id. */
export function termPatterns(terms: ReadonlyArray<TermSource>): Array<Pattern> {
  const out: Array<Pattern> = []
  for (const t of terms) {
    out.push({ id: t.id, text: t.name })
    for (const alias of t.aliases) out.push({ id: t.id, text: alias })
  }
  return out
}

export function termAutomaton(terms: ReadonlyArray<TermSource>): Automaton {
  return buildAutomaton(termPatterns(terms))
}

/**
 * The distinct term ids `text` mentions. A word said three times is one
 * mention: the graph records that the note talks about PUE, not how often.
 */
export function mentionedTermIds(
  automaton: Automaton,
  text: string,
): Set<string> {
  return new Set(findMatches(automaton, text).map((m) => m.id))
}
