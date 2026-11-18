import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ownership } from '@spaces/core/portfolio/ownership'
import { ClockProvider } from '#/components/clock'
import { OwnershipBlock } from './portfolio_.$holdingId'

/**
 * The holding's ownership rail: one row per counted round, and a `Sale` row
 * for a sale after the last of them, fed by `ownership()` itself so the
 * label is checked against the point the ledger rule actually adds.
 */

const NOW = '2026-01-15T12:00:00.000Z'

function rail() {
  const held = ownership(
    [
      {
        date: '2024-05-01',
        amount: 200_000,
        instrument: 'priced',
        shares: 100_000,
        reversedAt: null,
      },
    ],
    [
      // Counted, but before the check: no point.
      { date: '2024-04-25', kind: 'Seed', sharesOutstanding: 5_000_000 },
      { date: '2025-03-01', kind: 'Series A', sharesOutstanding: 8_000_000 },
    ],
    [{ date: '2025-09-01', sharesSold: 40_000, reversedAt: null }],
  )
  const html = renderToStaticMarkup(
    <ClockProvider now={NOW}>
      <OwnershipBlock ownership={held} />
    </ClockProvider>,
  )
  return html.split('data-ownership').slice(1)
}

describe('the ownership rail', () => {
  it('prints a sale after the last counted round as Sale, over that round’s count', () => {
    const rows = rail()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('Series A')
    expect(rows[0]).toContain('100,000 / 8,000,000')
    expect(rows[1]).toContain('>Sale<')
    expect(rows[1]).toContain('60,000 / 8,000,000')
    expect(rows[1]).not.toContain('>sale<')
  })
})
