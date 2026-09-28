import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReceiptHeader, receiptSentence } from './commit-receipt'
import type { ImportReceiptView } from '#/lib/import/commit'

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
