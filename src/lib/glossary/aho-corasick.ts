/**
 * Aho-Corasick over the glossary term set. ~120 lines and no dependency,
 * per CONTEXT.md — the alternative is a library that does the same thing
 * plus a bundle and a supply-chain surface.
 *
 * One pass over the note body finds every term and alias at once, which is
 * the point: a naive loop is O(terms × body) and gets slower every time the
 * investor defines a word.
 *
 * Matching rules, chosen to be predictable rather than clever:
 *  - case-insensitive
 *  - whole-word only: "stage" never matches inside "backstage" — and, by the
 *    same rule, never inside "stages" either. Stemming would make the
 *    highlight unexplainable, and a glossary that lights up unpredictably is
 *    worse than one that occasionally misses a plural.
 *  - longest match wins, leftmost first, never overlapping: with "space" and
 *    "in-space manufacturing" both defined, the phrase wins.
 */

export type Pattern = {
  /** The term entity this pattern belongs to — name and aliases share one. */
  id: string
  text: string
}

export type Match = {
  start: number
  end: number
  id: string
  /** The text as it appears in the haystack, not as the term defines it. */
  matched: string
}

type Node = {
  next: Map<string, number>
  fail: number
  /** Pattern lengths ending here, with their term id. */
  out: Array<{ id: string; length: number }>
}

export type Automaton = { nodes: Array<Node>; empty: boolean }

function node(): Node {
  return { next: new Map(), fail: 0, out: [] }
}

export function buildAutomaton(patterns: Array<Pattern>): Automaton {
  const nodes: Array<Node> = [node()]

  for (const p of patterns) {
    const text = p.text.trim().toLowerCase()
    if (!text) continue
    let cur = 0
    for (const ch of text) {
      let nxt = nodes[cur].next.get(ch)
      if (nxt === undefined) {
        nodes.push(node())
        nxt = nodes.length - 1
        nodes[cur].next.set(ch, nxt)
      }
      cur = nxt
    }
    nodes[cur].out.push({ id: p.id, length: text.length })
  }

  // Failure links, BFS. Depth-1 nodes fail to the root; deeper nodes fail to
  // the longest proper suffix that is also a prefix of some pattern.
  const queue: Array<number> = []
  for (const child of nodes[0].next.values()) {
    nodes[child].fail = 0
    queue.push(child)
  }
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const [ch, child] of nodes[cur].next) {
      let f = nodes[cur].fail
      while (f !== 0 && !nodes[f].next.has(ch)) f = nodes[f].fail
      const candidate = nodes[f].next.get(ch)
      nodes[child].fail = candidate !== undefined && candidate !== child ? candidate : 0
      // Inherit outputs so a match ending here also reports shorter patterns
      // that end here — resolved later by longest-wins.
      nodes[child].out.push(...nodes[nodes[child].fail].out)
      queue.push(child)
    }
  }

  return { nodes, empty: nodes.length === 1 }
}

/** Letters, digits and underscore. Hyphens are boundaries, so "in-space" is two words. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

export function findMatches(
  automaton: Automaton,
  haystack: string,
): Array<Match> {
  if (automaton.empty || !haystack) return []
  const lower = haystack.toLowerCase()
  const raw: Array<Match> = []

  let cur = 0
  // Index by code unit so offsets map back onto the original string. The
  // automaton is built from code points, so this only diverges on astral
  // characters, which cannot appear inside a word anyway.
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i]
    while (cur !== 0 && !automaton.nodes[cur].next.has(ch)) {
      cur = automaton.nodes[cur].fail
    }
    cur = automaton.nodes[cur].next.get(ch) ?? 0

    for (const hit of automaton.nodes[cur].out) {
      const end = i + 1
      const start = end - hit.length
      if (start < 0) continue
      // Whole-word only.
      if (isWordChar(lower[start - 1]) || isWordChar(lower[end])) continue
      raw.push({ start, end, id: hit.id, matched: haystack.slice(start, end) })
    }
  }

  // Leftmost-longest, non-overlapping.
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Array<Match> = []
  let consumedTo = 0
  for (const m of raw) {
    if (m.start < consumedTo) continue
    kept.push(m)
    consumedTo = m.end
  }
  return kept
}
