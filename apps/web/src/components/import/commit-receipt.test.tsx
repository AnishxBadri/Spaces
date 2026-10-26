import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  MissingRateLine,
  ReceiptHeader,
  VoidLine,
  ledgerReceiptSentence,
  receiptDestination,
  receiptSentence,
} from './commit-receipt'
import type { ImportReceiptView } from '#/lib/import/commit'
import type { LedgerReceipt } from '#/lib/import/ledger-commit'

const view = (over: Partial<ImportReceiptView> = {}): ImportReceiptView => ({
  status: 'committed',
  committedAt: '2026-09-29T08:00:00.000Z',
  counts: { written: 46, attached: 0, failed: 1, remaining: 0 },
  running: false,
  lastRun: {
    status: 'succeeded',
    line: '0 written · 0 attached · 0 failed · 46 unchanged',
    durationMs: 1234,
    startedAt: '2026-09-29T08:01:00.000Z',
  },
  rows: [],
  matching: 0,
  filter: 'all',
  object: { kind: 'company', plural: 'Companies', slug: 'companies' },
  ledger: null,
  ...over,
})

/** The receipt head under a router: its primary is a link. */
async function header(v: ImportReceiptView): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ReceiptHeader
          view={v}
          filename="companies.csv"
          onRetry={() => {}}
          pending={null}
        />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/import/b'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

/** The opening tag of the button whose label starts `label`. */
function button(html: string, label: string): string {
  const at = html.indexOf(`>${label}`)
  if (at === -1) throw new Error(`no ${label} button`)
  return html.slice(html.lastIndexOf('<button', at), at)
}

describe('the receipt header', () => {
  it('is the counts as a sentence, and a live run says what is left', () => {
    expect(
      receiptSentence(
        { written: 46, attached: 0, failed: 0, remaining: 0 },
        false,
      ),
    ).toBe('46 written · 0 attached.')
    expect(
      receiptSentence(
        { written: 12, attached: 1, failed: 1, remaining: 33 },
        true,
      ),
    ).toBe('12 written · 1 attached · 1 failed · 33 to go.')
  })

  it('prints the last run’s line, offers the retry, and opens the list it wrote — no Commit again', async () => {
    const html = await header(view())
    expect(html).toContain('46 written · 0 attached · 1 failed.')
    expect(html).toContain(
      'last run 0 written · 0 attached · 0 failed · 46 unchanged · 1.2 s',
    )
    expect(button(html, 'Retry failed rows')).not.toContain('disabled=""')
    expect(html).toMatch(/<a[^>]*href="\/companies"[^>]*>Open companies<\/a>/)
    expect(html).not.toContain('Commit again')
    expect(html).not.toContain('⌘↵')
  })

  it('disarms the retry while a run is live', async () => {
    const html = await header(view({ running: true }))
    expect(html).toContain('committing')
    expect(button(html, 'Retry failed rows')).toContain('disabled=""')
  })

  it('opens the list the batch wrote into: a custom object by its slug, a ledger the portfolio', () => {
    expect(receiptDestination(view())).toEqual({
      to: '/companies',
      label: 'Open companies',
    })
    expect(
      receiptDestination(
        view({ object: { kind: null, plural: 'Funds', slug: 'funds' } }),
      ),
    ).toEqual({ to: '/o/funds', label: 'Open funds' })
  })
})

describe('a ledger receipt (SPA-171)', () => {
  const ledger: LedgerReceipt = {
    counts: {
      holdings: 11,
      investments: 12,
      rounds: 9,
      marks: 8,
      distributions: 0,
    },
    missingRates: [
      { currency: 'AED', events: 2, earliest: '2022-04-10' },
      { currency: 'JPY', events: 2, earliest: '2024-02-01' },
    ],
    voidLine: 'void reaches 12 investments · 8 marks · 9 rounds stay',
    voidable: true,
    voided: false,
  }

  it('titles what landed and reads as the ledger', async () => {
    expect(
      ledgerReceiptSentence(
        ledger.counts,
        { written: 12, attached: 0, failed: 1, remaining: 0 },
        false,
      ),
    ).toBe('11 holdings · 12 investments · 9 rounds · 8 marks · 1 failed.')
    const html = await header(view({ ledger }))
    expect(html).toContain('Import · Ledger')
    expect(html).toContain('Open portfolio')
  })

  it('prints the void line with its action only while something is left to void', () => {
    // The missing-rate line carries a router `Link`, so its words are
    // asserted in core (`missingRateLine`) and it is drawn nothing here
    // when there is nothing missing.
    expect(
      renderToStaticMarkup(
        <MissingRateLine ledger={{ ...ledger, missingRates: [] }} />,
      ),
    ).toBe('')
    const voids = renderToStaticMarkup(
      <VoidLine
        ledger={ledger}
        onVoid={() => {}}
        voiding={false}
        onReimport={() => {}}
      />,
    )
    expect(voids).toContain(
      'void reaches 12 investments · 8 marks · 9 rounds stay',
    )
    expect(voids).toContain('void batch ›')
    expect(
      renderToStaticMarkup(
        <VoidLine
          ledger={{ ...ledger, voidable: false }}
          onVoid={() => {}}
          voiding={false}
          onReimport={() => {}}
        />,
      ),
    ).not.toContain('void batch')
  })

  it('after a void, the re-run is a quiet Re-import › under the voided line, never in the head (SPA-173)', async () => {
    const before = await header(view({ ledger }))
    expect(before).not.toContain('Re-import')

    const voided: LedgerReceipt = {
      ...ledger,
      voidLine: 'voided · 12 investments · 8 marks reversed · 9 rounds stay',
      voidable: false,
      voided: true,
    }
    const after = await header(view({ ledger: voided }))
    expect(after).not.toContain('Commit again')
    expect(after).not.toContain('Re-import')
    const line = renderToStaticMarkup(
      <VoidLine
        ledger={voided}
        onVoid={() => {}}
        voiding={false}
        onReimport={() => {}}
      />,
    )
    expect(line.indexOf('voided · 12 investments')).toBeLessThan(
      line.indexOf('Re-import ›'),
    )
    expect(button(line, 'Re-import ›')).not.toContain('disabled=""')
    expect(line).not.toContain('void batch')
  })
})
