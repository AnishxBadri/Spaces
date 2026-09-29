import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cite, humanizeSlug, survivor } from './cite'
import type { CiteLookup } from './cite'
import { ref } from './ref'

/**
 * Pure: a stubbed lookup stands in for `names.ts`, and nothing here needs a
 * database. The ids are fixed strings so the file reads as the table it is.
 */

const DOC = 'doc-1'
const CO = 'co-1'
const LOSER = 'co-loser'
const MANDATE = 'mandate-1'
const TERM = 'term-1'

const names = new Map<string, string>([
  [DOC, 'deck.pdf'],
  [CO, 'Acme'],
  [LOSER, 'Acme (dup)'],
  [MANDATE, 'Mandate'],
  [TERM, 'Power density'],
])
const merged = new Map<string, string>([[LOSER, CO]])
const attrs = new Map<string, string>([[`${CO}:stage`, 'Stage']])

const lookup: CiteLookup = {
  name: (id) => names.get(id),
  mergedInto: (id) => merged.get(id),
  attribute: (entityId, slug) => attrs.get(`${entityId}:${slug}`),
}

describe('cite', () => {
  it('names a document chunk by file and chunk index', () => {
    expect(cite(ref.doc(DOC, 4), lookup)).toBe('deck.pdf · chunk 4')
  })

  it('names an attribute on its record', () => {
    expect(cite(ref.attr(CO, 'stage'), lookup)).toBe('Stage on Acme')
  })

  it('names the mandate', () => {
    expect(cite(ref.mandate(MANDATE), lookup)).toBe('the mandate')
    expect(cite(ref.mandate('unknown'), lookup)).toBe('the mandate')
  })

  it('names a glossary term by the term', () => {
    expect(cite(ref.term(TERM), lookup)).toBe('Power density')
  })

  it('follows a merged loser to the winner', () => {
    expect(cite(ref.attr(LOSER, 'stage'), lookup)).toBe('Stage on Acme')
    expect(cite(ref.note(LOSER), lookup)).toBe('Acme')
  })

  it('stops on a merge cycle rather than spinning', () => {
    const cyc = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ])
    expect(['a', 'b']).toContain(survivor('a', (id) => cyc.get(id)))
  })

  it('humanizes a slug the registry does not name', () => {
    expect(cite(ref.attr(CO, 'funding_stage'), lookup)).toBe(
      'Funding stage on Acme',
    )
    expect(humanizeSlug('alias.domain')).toBe('Domain')
  })

  it('leaves an unparseable ref as it is', () => {
    expect(cite('nonsense', lookup)).toBe('nonsense')
  })

  it('imports neither drizzle nor the database', () => {
    const src = readFileSync(new URL('./cite.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/from ['"](drizzle-orm|@spaces\/db|#\/db)/)
  })
})
