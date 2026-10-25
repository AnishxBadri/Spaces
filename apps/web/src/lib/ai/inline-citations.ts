import { parseRef } from '@spaces/core/context/ref'

/**
 * Rewrites a model's ref citations (`[doc:<id>#3]`) into the words a person
 * reads ("(DD pack.pdf, p.4)"), because the note outlives the suggestion row
 * that carries the refs. Pure: the labels come in, nothing is fetched.
 *
 * - A bracket whose every entry parses as a ref (`parseRef`) is a citation;
 *   a list — `[doc:a#1, doc:a#2]` or `;`-separated — is one citation.
 * - A ref with no label is one the model did not read (made up, or cut by
 *   the budget): it is dropped, never printed, and a bracket left with
 *   nothing is removed with the space before it.
 * - A bracket followed by `(` is a markdown link and is not touched; so is
 *   any bracket holding something that is not a ref.
 * - Labels repeated inside one citation are printed once.
 */

const BRACKET = /(\s?)\[([^[\]\n]+)\](?!\()/g

/**
 * A label is a filename or a title, and `dd_pack_v2.pdf` would otherwise
 * open an emphasis when the body is parsed into blocks.
 */
const escapeLabel = (s: string): string => s.replace(/[\\`*_[\]]/g, '\\$&')

export type InlinedCitations = {
  markdown: string
  /** Every ref that was printed, in first-cited order, once each. */
  cited: Array<string>
}

export function inlineCitations(
  markdown: string,
  labels: ReadonlyMap<string, string>,
): InlinedCitations {
  const cited: Array<string> = []
  const out = markdown.replace(
    BRACKET,
    (whole: string, space: string, inner: string) => {
      const parts = inner
        .split(/[,;]/)
        .map((p) => p.trim())
        .filter((p) => p !== '')
      if (parts.length === 0 || !parts.every((p) => parseRef(p) !== null))
        return whole
      const words: Array<string> = []
      for (const r of parts) {
        const label = labels.get(r)
        if (label === undefined) continue
        if (!cited.includes(r)) cited.push(r)
        const word = escapeLabel(label)
        if (!words.includes(word)) words.push(word)
      }
      return words.length === 0 ? '' : `${space}(${words.join('; ')})`
    },
  )
  return { markdown: out, cited }
}
