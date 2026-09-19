import { describe, expect, it } from 'vitest'
import { DEFAULT_WEIGHTS, rank } from './rank'
import type { Candidate } from './rank'
import { ref } from './ref'

/**
 * Frostbyte Cooling, as the assembler would hand it to the ranker on
 * 2026-09-10. Every later property test perturbs this one fixture.
 */
const CO = 'co-frostbyte'
const DECK = 'doc-deck'
const MEMO = 'note-memo'
const SPACE_MEMO = 'note-space-memo'
const ASOF = '2026-09-10T00:00:00Z'

const attr = (slug: string, text: string): Candidate => ({
  ref: ref.attr(CO, slug),
  kind: 'attribute',
  text,
  entityIds: [CO],
  at: null,
  hop: 0,
})

const fixture: ReadonlyArray<Candidate> = [
  attr('description', 'Description: Immersion cooling for edge DCs'),
  attr('funding_stage', 'Funding stage: Seed'),
  attr('location', 'Location: Bengaluru'),
  {
    ref: ref.event('ev-stage'),
    kind: 'event',
    text: 'Stage: Sourced → First call (2026-08-29)',
    entityIds: [CO],
    at: '2026-08-29T10:00:00Z',
    hop: 0,
  },
  {
    ref: ref.memo(MEMO),
    kind: 'memo',
    text: 'Memo: Frostbyte — thesis fit on power density. The wedge is …',
    entityIds: [CO, MEMO],
    at: '2026-08-21T00:00:00Z',
    hop: 1,
    edge: 'tagged_in',
  },
  {
    ref: ref.doc(DECK, 0),
    kind: 'doc_chunk',
    text: 'Deck p.1: Frostbyte Cooling — seed. Problem: edge DCs run hot.',
    entityIds: [CO, DECK],
    at: '2026-08-20T00:00:00Z',
    hop: 1,
    edge: 'derived_from',
  },
  {
    ref: ref.doc(DECK, 1),
    kind: 'doc_chunk',
    text: 'Deck p.2: Team. Priya Rao (CEO, ex-Tata Power) …',
    entityIds: [CO, DECK],
    at: '2026-08-20T00:00:00Z',
    hop: 1,
    edge: 'derived_from',
  },
  {
    ref: ref.doc(DECK, 4),
    kind: 'doc_chunk',
    text: 'Deck p.5: Pilot at Tata Comms showed 40% PUE improvement.',
    entityIds: [CO, DECK],
    at: '2026-08-20T00:00:00Z',
    hop: 1,
    edge: 'derived_from',
  },
  {
    ref: ref.interaction('int-call'),
    kind: 'interaction',
    text: 'Call 2026-08-29 with Priya: pilot economics, intro to Tata Comms.',
    entityIds: [CO, 'person-priya'],
    at: '2026-08-29T11:00:00Z',
    hop: 1,
    edge: 'mentions',
  },
  {
    ref: ref.task('task-revisit'),
    kind: 'task',
    text: 'Task: revisit after round closes (due 2026-10-15)',
    entityIds: [CO],
    at: '2026-09-01T00:00:00Z',
    hop: 1,
    edge: 'mentions',
  },
  {
    ref: ref.memo(SPACE_MEMO),
    kind: 'memo',
    text: 'Memo: Data-center cooling — why we care. Power density is …',
    entityIds: ['space-cooling', SPACE_MEMO],
    at: '2026-06-02T00:00:00Z',
    hop: 2,
    edge: 'space',
  },
  {
    ref: ref.mandate('mandate-1'),
    kind: 'mandate',
    text: 'Mandate: stages seed, pre-seed. Geos IN. Check ₹80L–2Cr.',
    entityIds: [],
    at: '2026-08-14T00:00:00Z',
    hop: 'standing',
  },
  {
    ref: ref.term('term-immersion'),
    kind: 'glossary',
    text: 'Immersion cooling — submerging hardware in dielectric fluid.',
    entityIds: ['term-immersion'],
    at: null,
    hop: 'standing',
  },
]

const order = (r: ReturnType<typeof rank>) => r.items.map((i) => i.ref)

describe('rank', () => {
  it('what the analyzer would see for Frostbyte (snapshot)', () => {
    const r = rank(fixture, { asOf: ASOF, budgetChars: 4000 })
    expect(r).toMatchSnapshot()
  })

  it('is deterministic and independent of input order', () => {
    const a = rank(fixture, { asOf: ASOF, budgetChars: 4000 })
    const shuffled = [...fixture].reverse()
    const b = rank(shuffled, { asOf: ASOF, budgetChars: 4000 })
    expect(order(b)).toEqual(order(a))
    expect(b.items.map((i) => i.score)).toEqual(a.items.map((i) => i.score))
  })

  it('puts standing sources first, then attributes, then the graph by score', () => {
    const r = rank(fixture, { asOf: ASOF, budgetChars: 4000 })
    const kinds = r.items.map((i) => i.kind)
    expect(kinds.slice(0, 2)).toEqual(['mandate', 'glossary'])
    expect(kinds.slice(2, 5)).toEqual(['attribute', 'attribute', 'attribute'])
    // Graph items descend by score, except a document's second chunk,
    // which the one-chunk-per-doc floor defers behind every other item.
    const graph = r.items.slice(5)
    const docsSeen = new Set<string>()
    const firstPass = graph.filter((i) => {
      if (i.kind !== 'doc_chunk') return true
      const doc = i.ref.split('#')[0]
      if (docsSeen.has(doc)) return false
      docsSeen.add(doc)
      return true
    })
    for (let i = 1; i < firstPass.length; i++)
      expect(firstPass[i - 1].score! >= firstPass[i].score!).toBe(true)
  })

  it('recency: the stage event sinks below the deck as asOf moves on', () => {
    const now = rank(fixture, { asOf: ASOF, budgetChars: 4000 })
    const later = rank(fixture, {
      asOf: '2026-12-10T00:00:00Z',
      budgetChars: 4000,
    })
    const pos = (r: typeof now, target: string) => order(r).indexOf(target)
    expect(pos(now, 'event:ev-stage')).toBeLessThan(pos(now, `doc:${DECK}#0`))
    expect(pos(later, 'event:ev-stage')).toBeGreaterThan(
      pos(later, `doc:${DECK}#0`),
    )
    // timeless things do not move
    expect(later.items.find((i) => i.ref === `doc:${DECK}#0`)!.structural).toBe(
      now.items.find((i) => i.ref === `doc:${DECK}#0`)!.structural,
    )
  })

  it('attributes are the floor: taken before a higher-scored memo when tight', () => {
    const tight = rank(fixture, {
      asOf: ASOF,
      budgetChars: 90,
      standingShare: 0,
    })
    expect(tight.items.map((i) => i.kind)).toEqual([
      'attribute',
      'attribute',
      'attribute',
    ])
    expect(tight.dropped.map((d) => d.ref)).toContain(ref.memo(MEMO))
  })

  it('one chunk per document before any second chunk', () => {
    const chunks: Array<Candidate> = []
    for (const d of ['doc-a', 'doc-b'])
      for (const i of [0, 1, 2])
        chunks.push({
          ref: ref.doc(d, i),
          kind: 'doc_chunk',
          text: `${d} chunk ${i} ${'x'.repeat(20)}`,
          entityIds: [CO, d],
          at: d === 'doc-a' ? '2026-08-20T00:00:00Z' : '2026-08-10T00:00:00Z',
          hop: 1,
          edge: 'derived_from',
        })
    const r = rank(chunks, {
      asOf: ASOF,
      budgetChars: 3 * 35,
      standingShare: 0,
    })
    expect(order(r)).toEqual(['doc:doc-a#0', 'doc:doc-b#0', 'doc:doc-a#1'])
  })

  it('standing sources get a reserved slice; overflow is reported, unused returns to the pool', () => {
    const r = rank(fixture, {
      asOf: ASOF,
      budgetChars: 300,
      standingShare: 0.2,
    })
    // 60 chars reserved: mandate (55) fits, glossary does not
    expect(r.items[0].kind).toBe('mandate')
    expect(r.dropped).toContainEqual({
      ref: ref.term('term-immersion'),
      reason: 'standing_budget',
    })
    // attributes still landed from the remaining pool
    expect(r.items.filter((i) => i.kind === 'attribute').length).toBe(3)
    expect(r.usedChars).toBeLessThanOrEqual(300)
  })

  it('lexical lane: RRF lifts a chunk the task text matched', () => {
    const withLex = fixture.map((c) =>
      c.ref === ref.doc(DECK, 4) ? { ...c, lexicalRank: 1 } : c,
    )
    const base = rank(fixture, { asOf: ASOF, budgetChars: 4000 })
    const fused = rank(withLex, { asOf: ASOF, budgetChars: 4000 })
    const pos = (r: typeof base) => order(r).indexOf(ref.doc(DECK, 4))
    expect(pos(fused)).toBeLessThan(pos(base))
    // in fused mode the graph scores are RRF sums, structural is preserved
    const p5 = fused.items.find((i) => i.ref === ref.doc(DECK, 4))!
    expect(p5.structural).toBe(
      base.items.find((i) => i.ref === ref.doc(DECK, 4))!.structural,
    )
    // Structural rank counts attributes too (hop 0, score 1) and breaks ties
    // in the ranker's own order (at desc, ref asc); only standing is excluded.
    const structOrder = base.items
      .slice(2)
      .sort(
        (a, b) =>
          b.structural! - a.structural! ||
          (a.at === b.at ? 0 : a.at! < b.at! ? 1 : -1) ||
          (a.ref < b.ref ? -1 : 1),
      )
      .map((i) => i.ref)
    const structRank = structOrder.indexOf(ref.doc(DECK, 4)) + 1
    expect(p5.score).toBeCloseTo(1 / (60 + structRank) + 1 / 61, 9)
  })

  it('dedupes by ref, keeping the first', () => {
    const memo = fixture.find((c) => c.ref === ref.memo(MEMO))!
    const dup: Candidate = {
      ...memo,
      text: 'reached again via mentions',
      edge: 'mentions',
    }
    const r = rank([...fixture, dup], { asOf: ASOF, budgetChars: 4000 })
    const memos = r.items.filter((i) => i.ref === ref.memo(MEMO))
    expect(memos.length).toBe(1)
    expect(memos[0].text.startsWith('Memo: Frostbyte')).toBe(true)
  })

  it('ties break by at desc then ref asc, never by input order', () => {
    const mk = (id: string, at: string | null): Candidate => ({
      ref: ref.event(id),
      kind: 'event',
      text: 'e',
      entityIds: [CO],
      at,
      hop: 0,
    })
    const cands = [
      mk('b', null),
      mk('a', null),
      mk('old', '2026-09-01T00:00:00Z'),
      mk('new', '2026-09-09T00:00:00Z'),
    ]
    // give the dated ones equal scores by disabling decay
    const r = rank(cands, {
      asOf: ASOF,
      budgetChars: 1000,
      weights: {
        halfLifeDays: { ...DEFAULT_WEIGHTS.halfLifeDays, event: null },
      },
    })
    expect(order(r)).toEqual(['event:new', 'event:old', 'event:a', 'event:b'])
  })

  it('refuses a non-date asOf', () => {
    expect(() => rank(fixture, { asOf: 'yesterday', budgetChars: 10 })).toThrow(
      /asOf/,
    )
  })
})
