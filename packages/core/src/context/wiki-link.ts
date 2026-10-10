/**
 * Wiki links — the `[[Label|entity:<id>]]` form a note's derived markdown
 * carries for each mention. Text shown to a reader renders each as its label.
 * - A search snippet is a cut of the body, so a link can arrive with its
 *   head or its tail cut off; both halves render as what survives of the
 *   label, and a cut that kept only the target renders as nothing.
 */

const COMPLETE = /\[\[([^[\]|]*)\|[^[\]]*\]\]/g

/** The label part of a link's inside: everything before the first `|`. */
const labelOf = (inside: string): string => {
  const bar = inside.indexOf('|')
  return bar < 0 ? '' : inside.slice(0, bar)
}

/** `text` with every wiki link, whole or cut at an edge, as its label. */
export function renderWikiLinks(text: string): string {
  let out = text.replace(COMPLETE, '$1')
  // A tail cut: `[[Vayu Orb` or `[[Vayu Orbital|entity:0d3f` at the end.
  const open = out.lastIndexOf('[[')
  if (open >= 0 && !out.includes(']]', open)) {
    const inside = out.slice(open + 2)
    const bar = inside.indexOf('|')
    out = out.slice(0, open) + (bar < 0 ? inside : inside.slice(0, bar))
  }
  // A head cut: `Orbital|entity:0d3f…]]` or `0d3f…]]` at the start.
  const close = out.indexOf(']]')
  if (close >= 0 && !out.slice(0, close).includes('[[')) {
    out = labelOf(out.slice(0, close)) + out.slice(close + 2)
  }
  return out
}
