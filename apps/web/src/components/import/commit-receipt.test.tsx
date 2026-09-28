import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  MissingRateLine,
  ReceiptHeader,
  VoidLine,
  ledgerReceiptSentence,
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
  object: { kind: 'company', plural: 'Companies' },
  ledger: null,
  ...over,
})

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

  it('prints the last run’s line — a re-run says 0 written — and offers the retry', () => {
    const html = renderToStaticMarkup(
      <ReceiptHeader
        view={view()}
        filename="companies.csv"
        onCommit={() => {}}
        onRetry={() => {}}
        pending={null}
      />,
    )
    expect(html).toContain('46 written · 0 attached · 1 failed.')
    expect(html).toContain(
      'last run 0 written · 0 attached · 0 failed · 46 unchanged · 1.2 s',
    )
    expect(button(html, 'Retry failed rows')).not.toContain('disabled=""')
    expect(button(html, 'Commit again')).not.toContain('disabled=""')
  })

  it('disarms both actions while a run is live', () => {
    const html = renderToStaticMarkup(
      <ReceiptHeader
        view={view({ running: true })}
        filename="companies.csv"
        onCommit={() => {}}
        onRetry={() => {}}
        pending={null}
      />,
    )
    expect(html).toContain('committing')
    expect(button(html, 'Retry failed rows')).toContain('disabled=""')
    expect(button(html, 'Commit again')).toContain('disabled=""')
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

  it('titles what landed and reads as the ledger', () => {
    expect(
      ledgerReceiptSentence(
        ledger.counts,
        { written: 12, attached: 0, failed: 1, remaining: 0 },
        false,
      ),
    ).toBe('11 holdings · 12 investments · 9 rounds · 8 marks · 1 failed.')
    const html = renderToStaticMarkup(
      <ReceiptHeader
        view={view({ ledger })}
        filename="portfolio-tracker.csv"
        onCommit={() => {}}
        onRetry={() => {}}
        pending={null}
      />,
    )
    expect(html).toContain('Import · Ledger')
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

  it('after a void, the re-run is a quiet Re-import › under the voided line, not Commit again (SPA-173)', () => {
    const header = (l: LedgerReceipt) =>
      renderToStaticMarkup(
        <ReceiptHeader
          view={view({ ledger: l })}
          filename="portfolio-tracker.csv"
          onCommit={() => {}}
          onRetry={() => {}}
          pending={null}
        />,
      )
    const before = header(ledger)
    expect(button(before, 'Commit again')).not.toContain('disabled=""')
    expect(before).not.toContain('Re-import')

    const voided: LedgerReceipt = {
      ...ledger,
      voidLine: 'voided · 12 investments · 8 marks reversed · 9 rounds stay',
      voidable: false,
      voided: true,
    }
    const after = header(voided)
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
