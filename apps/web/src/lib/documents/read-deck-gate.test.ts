import { describe, expect, it } from 'vitest'
import { offersReadDeck } from './read-deck-gate'

describe('offersReadDeck', () => {
  it('is absent with the extract lane unrouted', () => {
    expect(
      offersReadDeck({ kind: 'deck', extractionStatus: 'done' }, false),
    ).toBe(false)
  })

  it('is absent unless the text is extracted', () => {
    for (const extractionStatus of ['pending', 'failed', 'unsupported'])
      expect(offersReadDeck({ kind: 'deck', extractionStatus }, true)).toBe(
        false,
      )
  })

  it('reads kind alone — every deck, however it was kinded, is one row', () => {
    expect(
      offersReadDeck({ kind: 'deck', extractionStatus: 'done' }, true),
    ).toBe(true)
    expect(
      offersReadDeck({ kind: 'cap_table', extractionStatus: 'done' }, true),
    ).toBe(false)
  })
})
