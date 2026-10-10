import type { SearchHit } from './query'

/**
 * Cmd-K's Records order: a typed name puts its record first. (D70)
 * - Tiers, then the fused order within a tier: the name equals the query,
 *   the name starts with it, any other name or alias match, then rows
 *   found only in text (a note body, a deck, a task).
 * - Reciprocal rank fusion alone ties a name hit with a body hit at the same
 *   rank and breaks the tie alphabetically, which can put a note above the
 *   record it names.
 */
export function nameFirst<T extends SearchHit>(
  hits: ReadonlyArray<T>,
  q: string,
): Array<T> {
  const typed = q.trim().toLowerCase()
  const tier = (hit: T): number => {
    if (hit.matchedIn !== 'name') return 3
    const name = hit.name.toLowerCase()
    if (name === typed) return 0
    if (name.startsWith(typed)) return 1
    return 2
  }
  return hits
    .map((hit, i) => ({ hit, i, t: tier(hit) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ hit }) => hit)
}
