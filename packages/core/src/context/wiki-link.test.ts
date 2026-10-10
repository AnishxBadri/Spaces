import { describe, expect, it } from 'vitest'
import { renderWikiLinks } from './wiki-link'

const ID = '0d3f6a1e-5b2c-4c8e-9f00-000000000001'

describe('renderWikiLinks', () => {
  it('renders a whole link as its label', () => {
    expect(
      renderWikiLinks(
        `Mentions: [[Vayu Orbital|entity:${ID}]] [[Flent|entity:${ID}]]`,
      ),
    ).toBe('Mentions: Vayu Orbital Flent')
  })

  it('keeps the «» marks a snippet puts on the label', () => {
    expect(
      renderWikiLinks(`leaks there. [[«Vayu» Orbital|entity:${ID}]]`),
    ).toBe('leaks there. «Vayu» Orbital')
  })

  it('renders a link cut at the tail as what survives of its label', () => {
    expect(
      renderWikiLinks('moves under everyone. [[Vayu Orbital|entity:0d3f'),
    ).toBe('moves under everyone. Vayu Orbital')
    expect(renderWikiLinks('moves under everyone. [[Va')).toBe(
      'moves under everyone. Va',
    )
  })

  it('renders a link cut at the head as its label, or nothing when only the target survived', () => {
    expect(renderWikiLinks(`Orbital|entity:${ID}]] said yes`)).toBe(
      'Orbital said yes',
    )
    expect(renderWikiLinks(`${ID.slice(9)}]] said yes`)).toBe(' said yes')
  })

  it('leaves text with no link alone', () => {
    expect(renderWikiLinks('a [plain] note | with bars')).toBe(
      'a [plain] note | with bars',
    )
  })
})
