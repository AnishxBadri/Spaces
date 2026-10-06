import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LedgerRow, LedgerSection, SectionHead } from './ledger-section.tsx'
import { RailSection, RecordSection } from './record/record-parts.tsx'
import { DialogHeader } from './ui/dialog.tsx'

/**
 * The Separation Rule as the shared primitives draw it: a hairline opens a
 * section, a 44px bone band carries a sentence-case title at the title step
 * with a mono count, ledger rows are 40px, the record table keeps 36, and a
 * dialog head is 48px on bone.
 */

const css = readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
)

/** Every class on the first element carrying `marker`. */
function classesOf(html: string, marker: string): Array<string> {
  const match = new RegExp(`class="([^"]*\\b${marker}\\b[^"]*)"`).exec(html)
  expect(match, marker).not.toBeNull()
  return (match?.[1] ?? '').split(/\s+/)
}

describe('row heights', () => {
  it('keeps the record table at 36 and names the ledger row 40', () => {
    expect(css).toContain('--row-h: 2.25rem;')
    expect(css).toContain('--ledger-row-h: 2.5rem;')
    expect(css).toContain('--spacing-row: var(--row-h);')
    expect(css).toContain('--spacing-ledger-row: var(--ledger-row-h);')
  })

  it('draws a ledger row at the ledger height, not the table one', () => {
    const html = renderToStaticMarkup(
      <LedgerSection label="Due">
        <LedgerRow>Chase the data room</LedgerRow>
      </LedgerSection>,
    )
    const row = classesOf(html, 'h-ledger-row')
    expect(row).not.toContain('h-row')
  })
})

describe('the section head band', () => {
  it('is 44px of bone, opened by a hairline, with a rule under', () => {
    const html = renderToStaticMarkup(<SectionHead title="Files" count="3" />)
    const band = classesOf(html, 'bg-bone')
    expect(band).toEqual(
      expect.arrayContaining([
        'h-11',
        'border-t',
        'border-b',
        'border-t-hairline',
        'border-b-rule',
      ]),
    )
  })

  it('titles in sentence case at the title step, never caps', () => {
    for (const html of [
      renderToStaticMarkup(
        <LedgerSection label="Idle in stage" count="2">
          {null}
        </LedgerSection>,
      ),
      renderToStaticMarkup(
        <RecordSection label="Interactions" meta="4">
          {null}
        </RecordSection>,
      ),
    ]) {
      expect(html).not.toContain('label-caps')
      expect(html).not.toContain('uppercase')
      const title = classesOf(html, 'text-title')
      expect(title).toEqual(
        expect.arrayContaining(['font-medium', 'text-foreground']),
      )
      expect(classesOf(html, 'mono')).toContain('text-graphite')
    }
  })

  it('gives a rail section the same title step, without a band', () => {
    const html = renderToStaticMarkup(
      <RailSection label="People" meta="2">
        {null}
      </RailSection>,
    )
    expect(html).not.toContain('label-caps')
    expect(html).not.toContain('bg-bone')
    expect(classesOf(html, 'text-title')).toContain('font-medium')
  })
})

describe('the dialog head', () => {
  it('is 48px on bone with a hairline under', () => {
    const html = renderToStaticMarkup(<DialogHeader>Head</DialogHeader>)
    expect(classesOf(html, 'bg-bone')).toEqual(
      expect.arrayContaining(['min-h-12', 'border-b', 'border-hairline']),
    )
  })
})
