import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PreviewHeader, ledgerItems, whatLands } from './preview-ledger'
import type { RowPlan } from '@spaces/core/import/plan'
import type { ImportPreviewView, PreviewRow } from '#/lib/import/plan'

/**
 * SPA-167. The preview's header and the ledger's grouping, server-rendered
 * with no DOM (`inbox.test.tsx`'s reason: the ledger's links want a router,
 * the header and the item list do not).
 */

const counts = {
  create: 31,
  attach: 12,
  noLand: 3,
  collide: 0,
  merged: 0,
  skip: 0,
  cellsSkipped: 0,
  total: 46,
}

const plan = (over: Partial<RowPlan>): RowPlan => ({
  verdict: 'create',
  creator: 'resolveEntity',
  name: 'Acme',
  patch: {},
  identity: {},
  errors: [],
  skippedCells: [],
  ...over,
})

const row = (rowNum: number, over: Partial<RowPlan> = {}): PreviewRow => ({
  rowNum,
  cells: [],
  plan: plan(over),
})

const view = (
  rows: Array<PreviewRow>,
  collisionRows: Array<PreviewRow> = [],
): ImportPreviewView => ({
  counts,
  filter: 'all',
  rows,
  matching: rows.length,
  collisionRows,
  matched: {},
  object: { kind: 'company', slug: 'companies', plural: 'Companies' },
  header: ['Name', 'Domain'],
})

describe('the preview header', () => {
  it('is the verdict sentence, names the file, and draws the commit disarmed', () => {
    const html = renderToStaticMarkup(
      <PreviewHeader
        counts={counts}
        filename="portfolio.csv"
        onBack={() => {}}
        backing={false}
      />,
    )
    expect(html).toContain('31 create · 12 attach · 3 will not land.')
    expect(html).toContain('nothing written yet')
    expect(html).toContain('Back to mapping')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Commit 43 rows/)
  })
})

describe('the ledger items', () => {
  it('draws a collision once, with a member outside the drawn window', () => {
    const items = ledgerItems(
      view(
        [
          row(1, { verdict: 'collide', collidesWith: [9] }),
          row(2),
          row(9, { verdict: 'collide', collidesWith: [1] }),
        ],
        [],
      ),
    )
    expect(items.map((i) => i.kind)).toEqual(['collision', 'row'])
    const first = items[0]
    expect(
      first.kind === 'collision' && first.rows.map((r) => r.rowNum),
    ).toEqual([1, 9])
    const outside = ledgerItems(
      view(
        [row(1, { verdict: 'collide', collidesWith: [300] })],
        [row(300, { verdict: 'collide', collidesWith: [1] })],
      ),
    )
    expect(
      outside[0].kind === 'collision' && outside[0].rows.map((r) => r.rowNum),
    ).toEqual([1, 300])
  })

  it('what lands counts attributes and identity keys, only for a landing row', () => {
    expect(
      whatLands(
        plan({ patch: { a: 1, b: 'x' }, identity: { domain: 'a.com' } }),
      ),
    ).toBe('3 values')
    expect(whatLands(plan({ verdict: 'no-land' }))).toBe('')
  })
})
