import { describe, expect, it } from 'vitest'
import { SYSTEM_ATTRIBUTES } from '@spaces/core/attributes/registry'
import type { AttributeOptions } from '@spaces/core/attributes/registry'
import {
  OWN_SECTIONS,
  isLongText,
  pairSectionDefs,
  recordRailDefs,
} from './rail-defs'

/**
 * Each record page's rail rows: a relationship the rail draws as a section
 * is never also a row, one with no section stays a row, and what the head
 * already says is left out.
 */

type Def = {
  slug: string
  type: string
  options: AttributeOptions
  pair: { archived: boolean } | null
}

/** A core kind's registry as `listRegistry` hands it to the page, paired. */
const registry = (kind: 'company' | 'person' | 'deal'): Array<Def> =>
  SYSTEM_ATTRIBUTES[kind].map((d) => ({
    slug: d.slug,
    type: d.type,
    options: {
      ...(d.options ?? {}),
      ...(d.pair ? { inverseOf: `${d.pair.kind}.${d.pair.slug}` } : {}),
    },
    pair: d.pair ? { archived: false } : null,
  }))

const slugs = (defs: ReadonlyArray<Def>) => defs.map((d) => d.slug)

/** What the page draws as a section: its own groups and the generic ones. */
const sections = (
  kind: keyof typeof OWN_SECTIONS,
  defs: ReadonlyArray<Def>,
) => [
  ...OWN_SECTIONS[kind],
  ...slugs(pairSectionDefs(defs, OWN_SECTIONS[kind])),
]

describe('a relationship shows once', () => {
  it('on a company: Team and Associated deals are sections, Founders stays a row', () => {
    const defs = registry('company')
    const rail = slugs(recordRailDefs('company', defs))
    expect(sections('company', defs)).toEqual(['team', 'associated_deals'])
    expect(rail).not.toContain('team')
    expect(rail).not.toContain('associated_deals')
    expect(rail).toContain('founders')
  })

  it('on a person: Companies and Deals are sections, and the name parts are the title', () => {
    const defs = registry('person')
    const rail = slugs(recordRailDefs('person', defs))
    expect(sections('person', defs)).toEqual(['companies', 'deals'])
    for (const gone of ['companies', 'deals', 'first_name', 'last_name'])
      expect(rail).not.toContain(gone)
    expect(rail.slice(0, 2)).toEqual(['emails', 'phone'])
  })

  it('on a deal: Company and People are sections, Referred by stays a row, Stage is the head’s', () => {
    const defs = registry('deal')
    const rail = slugs(recordRailDefs('deal', defs))
    expect(sections('deal', defs)).toEqual(['company', 'people'])
    for (const gone of ['company', 'people', 'stage'])
      expect(rail).not.toContain(gone)
    expect(rail).toContain('referred_by')
    expect(rail.slice(0, 4)).toEqual(['value', 'close_date', 'owner', 'source'])
  })

  it('on a custom record: a paired relationship is its section, a plain reference stays a row', () => {
    const defs: Array<Def> = [
      { slug: 'name_note', type: 'text', options: {}, pair: null },
      {
        slug: 'portfolio',
        type: 'record_reference',
        options: { targetKind: 'company', multi: true, inverseOf: 'x' },
        pair: { archived: false },
      },
      {
        slug: 'contact',
        type: 'record_reference',
        options: { targetKind: 'person' },
        pair: null,
      },
    ]
    const rail = slugs(recordRailDefs('custom', defs))
    expect(sections('custom', defs)).toEqual(['portfolio'])
    expect(rail).toEqual(['name_note', 'contact'])
  })

  it('never drops a section and its row both: every relationship is one or the other', () => {
    for (const kind of ['company', 'person', 'deal'] as const) {
      const defs = registry(kind)
      const rail = slugs(recordRailDefs(kind, defs))
      const drawn = sections(kind, defs)
      for (const d of defs.filter((x) => x.type === 'record_reference'))
        expect(rail.includes(d.slug) !== drawn.includes(d.slug)).toBe(true)
    }
  })
})

describe('long text', () => {
  it('is the three seeded paragraphs, and only a text attribute can be one', () => {
    const long = (['company', 'person', 'deal'] as const).flatMap((kind) =>
      registry(kind)
        .filter(isLongText)
        .map((d) => `${kind}.${d.slug}`),
    )
    expect(long).toEqual([
      'company.description',
      'person.description',
      'deal.close_reason',
    ])
    expect(
      isLongText({ slug: 'n', type: 'number', options: { longText: true } }),
    ).toBe(false)
  })
})
