import { describe, expect, it } from 'vitest'
import { DOCUMENT_KINDS } from '../documents'
import {
  KEY_TERMS,
  KEY_TERM_KINDS,
  isKeyTermKind,
  keyTermsMarkdown,
  keyTermsSchema,
  readKeyTerms,
} from './key-terms'

/**
 * SPA-91. The per-kind key-terms schema is hand-written, not compiled from
 * the registry (the module comment says why), so this snapshot is the one
 * place a reviewer sees the output type the extract lane is handed for a
 * term sheet and for a diligence pack. @spaces/core's suite has no model
 * and no connection string by construction.
 */

describe('keyTermsSchema', () => {
  it('is the legal output type', () => {
    expect(keyTermsSchema('legal')).toMatchSnapshot()
  })

  it('is the diligence output type', () => {
    expect(keyTermsSchema('dd')).toMatchSnapshot()
  })

  it('requires no term, and requires a ref on every term it carries', () => {
    for (const kind of KEY_TERM_KINDS) {
      const schema = keyTermsSchema(kind)
      expect(schema.required).toBeUndefined()
      for (const prop of Object.values(schema.properties ?? {})) {
        expect(prop.required).toEqual(['value', 'refs'])
        expect(prop.properties?.refs.minItems).toBe(1)
      }
    }
  })

  it('names the terms the issue lists for a legal document', () => {
    expect(KEY_TERMS.legal.map((t) => t.slug)).toEqual(
      expect.arrayContaining([
        'liquidation_preference',
        'pro_rata',
        'board_composition',
        'exclusivity',
        'governing_law',
      ]),
    )
  })

  it('covers legal and dd, and no other document kind', () => {
    expect(DOCUMENT_KINDS.filter(isKeyTermKind)).toEqual(['dd', 'legal'])
    expect(isKeyTermKind('article')).toBe(false)
  })
})

describe('readKeyTerms', () => {
  it('keeps stated terms in vocabulary order, and leaves out what was not stated', () => {
    const { terms, dropped } = readKeyTerms('legal', {
      governing_law: { value: 'England and Wales', refs: ['doc:a#3'] },
      liquidation_preference: {
        value: '1x  non-participating',
        refs: ['doc:a#1', 'doc:a#1'],
      },
      pro_rata: null,
      board_composition: { value: 'Not found', refs: ['doc:a#2'] },
      exclusivity: { value: 'N/A', refs: ['doc:a#2'] },
      information_rights: { value: '  ', refs: ['doc:a#2'] },
      protective_provisions: { value: 'Majority consent', refs: [] },
    })
    expect(terms).toEqual([
      {
        slug: 'liquidation_preference',
        term: 'Liquidation preference',
        value: '1x non-participating',
        refs: ['doc:a#1'],
      },
      {
        slug: 'governing_law',
        term: 'Governing law',
        value: 'England and Wales',
        refs: ['doc:a#3'],
      },
    ])
    expect(dropped).toEqual([])
  })

  it('names what is not the envelope, or not a term of the kind', () => {
    const { terms, dropped } = readKeyTerms('dd', {
      litigation: 'none pending',
      governing_law: { value: 'Delaware', refs: ['doc:a#0'] },
    })
    expect(terms).toEqual([])
    expect(dropped).toEqual(['governing_law', 'litigation'])
    expect(readKeyTerms('dd', 'nonsense')).toEqual({ terms: [], dropped: [] })
  })
})

describe('keyTermsMarkdown', () => {
  it('is a term / value / citation table whose cells cannot break it', () => {
    expect(
      keyTermsMarkdown([
        {
          term: 'Liquidation preference',
          value: '1x | non-participating *senior*',
          citation: 'term_sheet.pdf, p.2',
        },
      ]),
    ).toBe(
      [
        '| Term | Value | Citation |',
        '| --- | --- | --- |',
        '| Liquidation preference | 1x \\| non-participating \\*senior\\* | term\\_sheet.pdf, p.2 |',
      ].join('\n'),
    )
  })
})
