import { describe, expect, it } from 'vitest'
import { offersKeyTerms } from './key-terms-gate'

/** SPA-91: which Files-tab rows offer Extract key terms. */

const onDeal = [{ kind: 'record' as const, entityKind: 'deal' }]

describe('offersKeyTerms', () => {
  it('offers on a legal document filed on a deal, and on a diligence pack', () => {
    for (const kind of ['legal', 'dd'])
      expect(
        offersKeyTerms(
          { kind, extractionStatus: 'done', filedIn: onDeal },
          true,
        ),
      ).toBe(true)
  })

  it('offers nothing on an article, a deck or an unclassified file', () => {
    for (const kind of ['article', 'deck', 'other'])
      expect(
        offersKeyTerms(
          { kind, extractionStatus: 'done', filedIn: onDeal },
          true,
        ),
      ).toBe(false)
  })

  it('is hidden with no deal in the filing', () => {
    expect(
      offersKeyTerms(
        {
          kind: 'legal',
          extractionStatus: 'done',
          filedIn: [
            { kind: 'record', entityKind: 'company' },
            { kind: 'space' },
          ],
        },
        true,
      ),
    ).toBe(false)
    expect(
      offersKeyTerms(
        { kind: 'legal', extractionStatus: 'done', filedIn: [] },
        true,
      ),
    ).toBe(false)
  })

  it('is hidden while the text is not extracted, or the lane is unrouted', () => {
    expect(
      offersKeyTerms(
        { kind: 'legal', extractionStatus: 'pending', filedIn: onDeal },
        true,
      ),
    ).toBe(false)
    expect(
      offersKeyTerms(
        { kind: 'legal', extractionStatus: 'done', filedIn: onDeal },
        false,
      ),
    ).toBe(false)
  })
})
