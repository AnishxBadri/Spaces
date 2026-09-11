import type { ContextEdge, ContextHop, ContextItem, ContextKind } from './types'
import { docOfRef } from './ref'

/**
 * The ranker — the pure half of the assembler (docs/spec-ai-substrate.md
 * §1, ranking decided 2026-09-09). Rows in, ranked + trimmed items out. No
 * database, no model, no clock: `asOf` is an input, so the same candidates
 * always produce the same output and "what would the analyzer see" is a
 * snapshot fixture.
 *
 * Score = hop × edge × kind prior × recency. Multiplicative, three factors,
 * all deterministic. When the task carried text, a lexical lane (tsv rank,
 * supplied per candidate) is fused by reciprocal rank fusion — the same
 * trick search.ts uses, and the seam an embedding lane joins later.
 *
 * Standing sources (mandate, glossary) are not ranked against the graph:
 * they take a reserved slice of the budget. Attributes at hop 0 are taken
 * first. One chunk per document lands before any document's second.
 */

// ---------- input ----------

export type Candidate = ContextItem & {
  hop: ContextHop
  /** Edge the walk took to reach this item (hop ≥ 1). */
  edge?: ContextEdge
  /** 1-based rank in the lexical lane, when the task carried text. */
  lexicalRank?: number
}

export type Weights = {
  hop: Record<0 | 1 | 2, number>
  edge: Record<ContextEdge, number>
  prior: Record<Exclude<ContextKind, 'mandate' | 'glossary'>, number>
  /** Half-life in days; null = no decay. */
  halfLifeDays: Record<ContextKind, number | null>
  /** RRF constant. */
  rrfK: number
}

export const DEFAULT_WEIGHTS: Weights = {
  hop: { 0: 1, 1: 0.6, 2: 0.3 },
  edge: {
    references: 1,
    tagged_in: 1,
    space: 0.8,
    mentions: 0.7,
    co_investor: 0.6,
    contact_at: 0.5,
    derived_from: 0.5,
    supersedes: 0.5,
  },
  prior: {
    attribute: 1,
    memo: 0.9,
    event: 0.8,
    note: 0.7,
    doc_chunk: 0.6,
    interaction: 0.6,
    task: 0.5,
  },
  halfLifeDays: {
    attribute: null,
    doc_chunk: null, // a deck is true until superseded
    event: 30,
    task: 30,
    interaction: 60,
    note: 180,
    memo: 365,
    mandate: null,
    glossary: null,
  },
  rrfK: 60,
}

export type RankOptions = {
  /** ISO 8601. The only clock the ranker knows. */
  asOf: string
  /** Characters. Callers convert from tokens (× 4). */
  budgetChars: number
  /** Share of budget reserved for standing sources. Default 0.2. */
  standingShare?: number
  weights?: Partial<Weights>
}

// ---------- output ----------

export type RankedItem = ContextItem & {
  hop: ContextHop
  /** hop × edge × prior × recency; null for standing items. */
  structural: number | null
  /** Final ordering key: structural, or the RRF sum when a lexical lane ran. */
  score: number | null
}

export type DropReason = 'budget' | 'standing_budget'

export type RankResult = {
  /** Standing items first (mandate, then glossary), then ranked. */
  items: ReadonlyArray<RankedItem>
  dropped: ReadonlyArray<{ ref: string; reason: DropReason }>
  /** Characters used, for the caller's own accounting. */
  usedChars: number
}

// ---------- scoring ----------

const DAY_MS = 86_400_000

function recency(
  kind: ContextKind,
  at: string | null,
  asOfMs: number,
  w: Weights,
): number {
  const hl = w.halfLifeDays[kind]
  if (hl == null || at == null) return 1
  const ageDays = Math.max(0, (asOfMs - Date.parse(at)) / DAY_MS)
  return Math.pow(0.5, ageDays / hl)
}

function structural(c: Candidate, asOfMs: number, w: Weights): number {
  if (c.hop === 'standing') return 0
  if (c.kind === 'mandate' || c.kind === 'glossary') return 0
  const edge = c.hop === 0 ? 1 : c.edge ? w.edge[c.edge] : 1
  return (
    w.hop[c.hop] * edge * w.prior[c.kind] * recency(c.kind, c.at, asOfMs, w)
  )
}

/** Total order: score desc → at desc (null last) → ref asc. Never row order. */
function compare(a: RankedItem, b: RankedItem): number {
  const sa = a.score ?? -1
  const sb = b.score ?? -1
  if (sa !== sb) return sb - sa
  if (a.at !== b.at) {
    if (a.at == null) return 1
    if (b.at == null) return -1
    return a.at < b.at ? 1 : -1
  }
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0
}

// ---------- rank ----------

export function rank(
  candidates: ReadonlyArray<Candidate>,
  opts: RankOptions,
): RankResult {
  const w: Weights = { ...DEFAULT_WEIGHTS, ...opts.weights }
  const asOfMs = Date.parse(opts.asOf)
  if (Number.isNaN(asOfMs)) throw new Error(`rank: asOf is not a date`)
  const share = opts.standingShare ?? 0.2

  // Dedupe by ref: the walk can reach one row by two edges. Keep the first
  // in input order — callers emit hop 0 before hop 1.
  const seen = new Set<string>()
  const unique = candidates.filter((c) =>
    seen.has(c.ref) ? false : (seen.add(c.ref), true),
  )

  const standing = unique.filter(
    (c) =>
      c.hop === 'standing' || c.kind === 'mandate' || c.kind === 'glossary',
  )
  const graph = unique.filter((c) => !standing.includes(c))

  // Structural lane.
  const lexical = new Map<string, number>()
  for (const c of graph)
    if (c.lexicalRank != null) lexical.set(c.ref, c.lexicalRank)
  const scored: Array<RankedItem> = graph.map((c) => {
    const s = structural(c, asOfMs, w)
    return { ...strip(c), hop: c.hop, structural: s, score: s }
  })
  scored.sort(compare)

  // Lexical lane present → fuse by RRF; otherwise score stays structural.
  if (lexical.size > 0) {
    scored.forEach((c, i) => {
      const structRank = i + 1
      let s = 1 / (w.rrfK + structRank)
      const lr = lexical.get(c.ref)
      if (lr != null) s += 1 / (w.rrfK + lr)
      c.score = s
    })
    scored.sort(compare)
  }

  // Standing: mandate first, then glossary; within a kind by ref.
  const standingRanked: Array<RankedItem> = standing
    .map((c) => ({
      ...strip(c),
      hop: 'standing' as const,
      structural: null,
      score: null,
    }))
    .sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === 'mandate'
          ? -1
          : 1
        : a.ref < b.ref
          ? -1
          : a.ref > b.ref
            ? 1
            : 0,
    )

  // ---------- budget ----------
  const dropped: Array<{ ref: string; reason: DropReason }> = []
  const out: Array<RankedItem> = []
  let used = 0

  // Reserved slice for standing sources; whatever it doesn't use returns
  // to the pool.
  const standingBudget = Math.floor(opts.budgetChars * share)
  let standingUsed = 0
  for (const s of standingRanked) {
    const n = s.text.length
    if (standingUsed + n <= standingBudget) {
      out.push(s)
      standingUsed += n
    } else dropped.push({ ref: s.ref, reason: 'standing_budget' })
  }
  used += standingUsed

  const remaining = () => opts.budgetChars - used
  const take = (c: RankedItem) => {
    out.push(c)
    used += c.text.length
  }

  // Floor 1: hop-0 attributes, in ranked order, before anything else.
  const rest: Array<RankedItem> = []
  for (const c of scored) {
    if (c.hop === 0 && c.kind === 'attribute') {
      if (c.text.length <= remaining()) take(c)
      else dropped.push({ ref: c.ref, reason: 'budget' })
    } else rest.push(c)
  }

  // Floor 2: one chunk per document before any document's second. Greedy
  // skip-and-continue so a small item after a big one still fits.
  const docsSeen = new Set<string>()
  const deferred: Array<RankedItem> = []
  for (const c of rest) {
    const doc = c.kind === 'doc_chunk' ? docOfRef(c.ref) : null
    if (doc && docsSeen.has(doc)) {
      deferred.push(c)
      continue
    }
    if (c.text.length <= remaining()) {
      take(c)
      if (doc) docsSeen.add(doc)
    } else dropped.push({ ref: c.ref, reason: 'budget' })
  }
  for (const c of deferred) {
    if (c.text.length <= remaining()) take(c)
    else dropped.push({ ref: c.ref, reason: 'budget' })
  }

  return {
    items: out,
    dropped,
    usedChars: used,
  }
}

function strip(c: Candidate): ContextItem {
  return {
    ref: c.ref,
    kind: c.kind,
    text: c.text,
    entityIds: c.entityIds,
    at: c.at,
  }
}
