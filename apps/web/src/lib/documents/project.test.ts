import { describe, expect, it } from 'vitest'
import { matchesConditions, opsFor } from '@spaces/core/views/filter'
import type { Condition } from '@spaces/core/views/filter'
import {
  DOCUMENT_REGISTRY,
  documentFieldType,
  documentRegistry,
} from './registry'
import { projectDocument } from './project'
import type { ProjectableDocument } from './project'

/**
 * The seam between the shelf and the pure filter model: a hand-built row,
 * projected, run through the *unchanged* `matchesConditions`. No database —
 * the projection is pure and the registry is a constant, which is the whole
 * point of both.
 */

const SPACE_ID = 'sp-aerospace'
const COMPANY_ID = 'co-madein'

function doc(over: Partial<ProjectableDocument> = {}): ProjectableDocument {
  return {
    kind: 'deck',
    extractionStatus: 'done',
    sourceClass: 'manual',
    records: [],
    spaces: [],
    ...over,
  }
}

/** What the page does: project, then evaluate with the surface's types. */
const matches = (r: ProjectableDocument, conditions: Array<Condition>) =>
  matchesConditions(projectDocument(r), conditions, documentFieldType)

describe('document surface projection', () => {
  it('keys a row by the registry slugs', () => {
    const values = projectDocument(
      doc({
        kind: 'legal',
        extractionStatus: 'failed',
        sourceClass: 'integration',
        spaces: [{ id: SPACE_ID, name: 'Aerospace' }],
        records: [
          {
            id: COMPANY_ID,
            name: 'Made In Space',
            kind: 'company',
            objectSlug: 'companies',
          },
        ],
      }),
    )
    expect(values).toEqual({
      kind: 'legal',
      extraction: 'failed',
      origin: 'integration',
      space: [SPACE_ID],
      filed_against: [COMPANY_ID],
      filed: true,
    })
    // Every key the projection writes is a field the registry can type —
    // otherwise the evaluator would silently ignore a condition on it.
    for (const slug of Object.keys(values))
      expect(documentFieldType(slug)).toBeTypeOf('string')
  })

  it('matches a space-filed document on a space condition', () => {
    const filed = doc({ spaces: [{ id: SPACE_ID, name: 'Aerospace' }] })
    const elsewhere = doc({ spaces: [{ id: 'sp-bio', name: 'Bio' }] })
    const cond: Array<Condition> = [
      { slug: 'space', op: 'is', value: SPACE_ID },
    ]
    expect(matches(filed, cond)).toBe(true)
    expect(matches(elsewhere, cond)).toBe(false)
    expect(matches(doc(), cond)).toBe(false)
  })

  it('matches a record-filed document on a filed_against condition', () => {
    const filed = doc({
      records: [
        {
          id: COMPANY_ID,
          name: 'Made In Space',
          kind: 'company',
          objectSlug: 'companies',
        },
        { id: 'de-seed', name: 'Seed', kind: 'deal', objectSlug: 'deals' },
      ],
    })
    // Multi-valued: "is X" means X is among them, so a deck filed in two
    // places matches a condition naming either.
    expect(
      matches(filed, [{ slug: 'filed_against', op: 'is', value: 'de-seed' }]),
    ).toBe(true)
    expect(
      matches(filed, [
        { slug: 'filed_against', op: 'is_not', value: 'de-seed' },
      ]),
    ).toBe(false)
    expect(matches(doc(), [{ slug: 'filed_against', op: 'empty' }])).toBe(true)
  })

  it('matches an unfiled document on filed is_not true, and on filed is false', () => {
    const unfiled = doc()
    const filed = doc({ spaces: [{ id: SPACE_ID, name: 'Aerospace' }] })
    // `opsFor('checkbox')` offers only `is`, so that is what the popover
    // writes; `is_not` is still evaluated for a condition that carries it.
    expect(opsFor('checkbox')).toEqual(['is'])
    expect(matches(unfiled, [{ slug: 'filed', op: 'is', value: false }])).toBe(
      true,
    )
    expect(matches(filed, [{ slug: 'filed', op: 'is', value: false }])).toBe(
      false,
    )
    expect(
      matches(unfiled, [{ slug: 'filed', op: 'is_not', value: true }]),
    ).toBe(true)
    expect(matches(filed, [{ slug: 'filed', op: 'is_not', value: true }])).toBe(
      false,
    )
  })

  it('matches kind and extraction selects, and ANDs them', () => {
    const scanned = doc({ kind: 'deck', extractionStatus: 'unsupported' })
    const both: Array<Condition> = [
      { slug: 'kind', op: 'is', value: 'deck' },
      { slug: 'extraction', op: 'is', value: 'unsupported' },
    ]
    expect(matches(scanned, both)).toBe(true)
    expect(matches(doc({ kind: 'legal' }), both)).toBe(false)
    expect(
      matches(doc({ sourceClass: 'integration' }), [
        { slug: 'origin', op: 'is', value: 'integration' },
      ]),
    ).toBe(true)
  })

  it('ignores a condition on an unknown slug rather than excluding every row', () => {
    expect(documentFieldType('stage')).toBeUndefined()
    expect(matches(doc(), [{ slug: 'stage', op: 'is', value: 'seed' }])).toBe(
      true,
    )
    // …and it still applies the conditions it does understand.
    expect(
      matches(doc({ kind: 'legal' }), [
        { slug: 'stage', op: 'is', value: 'seed' },
        { slug: 'kind', op: 'is', value: 'deck' },
      ]),
    ).toBe(false)
  })
})

describe('document surface registry', () => {
  it('types every field it declares, and offers no new operators', () => {
    for (const d of DOCUMENT_REGISTRY)
      expect(opsFor(d.type).length).toBeGreaterThan(0)
    expect(opsFor('select')).toEqual(['is', 'is_not', 'empty', 'not_empty'])
  })

  it('fills space and filed_against options from the loaded rows', () => {
    const rows = [
      doc({
        spaces: [{ id: SPACE_ID, name: 'Aerospace' }],
        records: [
          {
            id: COMPANY_ID,
            name: 'Made In Space',
            kind: 'company',
            objectSlug: 'companies',
          },
        ],
      }),
      // The same space twice is one option, not two.
      doc({ spaces: [{ id: SPACE_ID, name: 'Aerospace' }] }),
    ]
    const live = documentRegistry(rows)
    expect(live.find((d) => d.slug === 'space')?.options?.options).toEqual([
      { id: SPACE_ID, label: 'Aerospace' },
    ])
    expect(
      live.find((d) => d.slug === 'filed_against')?.options?.options,
    ).toEqual([{ id: COMPANY_ID, label: 'Made In Space' }])
    // The fixed lists are untouched, and the constant itself is not mutated.
    expect(live.find((d) => d.slug === 'kind')?.options?.options).toHaveLength(
      6,
    )
    expect(
      DOCUMENT_REGISTRY.find((d) => d.slug === 'space')?.options?.options,
    ).toEqual([])
  })
})
