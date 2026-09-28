import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CompanyRow,
  FailedRow,
  eventsText,
  ledgerStripCells,
} from './ledger-preview'
import type { LedgerCompanyReport } from '@spaces/core/import/ledger'

/**
 * SPA-170. The ledger preview's rows, server-rendered with no DOM: a company
 * with its events in date order in the what-lands lane, and a stopped row
 * whose SAFE is decided per row carrying its picker.
 */

const pixxel: LedgerCompanyReport = {
  company: 'entity:e-1',
  name: 'Pixxel',
  entityId: 'e-1',
  verdict: 'attach',
  holding: 'birth',
  rows: [1, 8],
  events: [
    {
      date: '2023-03-15',
      kind: 'round',
      rowNum: 1,
      text: 'round Seed 2023-03-15',
    },
    {
      date: '2023-03-15',
      kind: 'investment',
      rowNum: 1,
      text: 'investment $50,000 priced',
    },
    {
      date: '2025-12-31',
      kind: 'mark',
      rowNum: 1,
      text: 'mark $120,000 2025-12-31',
    },
  ],
}

const LINE =
  'round Seed 2023-03-15 · investment $50,000 priced · mark $120,000 2025-12-31'

describe('the ledger preview', () => {
  it('draws one row per company with its events in the what-lands lane', () => {
    const html = renderToStaticMarkup(<CompanyRow company={pixxel} />)
    expect(eventsText(pixxel)).toBe(LINE)
    expect(html).toContain('Pixxel')
    expect(html).toContain('1, 8')
    expect(html).toContain('new holding')
    expect(html).toContain(LINE)
  })

  it('a SAFE decided per row carries its picker; any other stop says fix the sheet', () => {
    const noop = () => undefined
    const perRow = renderToStaticMarkup(
      <FailedRow
        row={{
          rowNum: 4,
          name: 'Kalpa',
          why: 'Instrument · "SAFE" could be safe_post_money or safe_pre_money',
          perRow: {
            raw: 'SAFE',
            candidates: ['safe_post_money', 'safe_pre_money'],
          },
        }}
        disabled={false}
        onDecide={noop}
      />,
    )
    expect(perRow).toContain('Instrument for row 4')
    const stopped = renderToStaticMarkup(
      <FailedRow
        row={{
          rowNum: 2,
          name: 'Ohmium',
          why: 'Amount · no amount',
          perRow: null,
        }}
        disabled={false}
        onDecide={noop}
      />,
    )
    expect(stopped).toContain('fix in the sheet, re-upload')
  })

  it('reads the five counts the strip shows', () => {
    const cells = ledgerStripCells({
      holdings: 10,
      births: 9,
      rounds: 9,
      investments: 11,
      marks: 7,
      distributions: 0,
      noLand: 1,
      needDecision: 1,
      total: 12,
    })
    expect(cells.map((c) => [c.label, c.value])).toEqual([
      ['Holdings', 10],
      ['Rounds', 9],
      ['Investments', 11],
      ['Marks', 7],
      ['Need a decision', 1],
    ])
  })
})
