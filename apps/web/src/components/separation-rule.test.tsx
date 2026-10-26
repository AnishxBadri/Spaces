import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  Band,
  EmptyRow,
  FoldRow,
  LabelHead,
  LedgerRow,
  LedgerSection,
  SectionHead,
} from './ledger-section.tsx'
import { RailSection, RecordSection } from './record/record-parts.tsx'
import { DialogHeader } from './ui/dialog.tsx'
import { Segmented } from './ui/segmented.tsx'

/**
 * The Separation Rule as the shared primitives draw it: a hairline opens a
 * section, a 44px bone band carries a sentence-case title at the title step
 * with its mono ink count (or a Segmented) at the right, a group inside a
 * pane opens on a 28px band, an empty section is one `Name +` row, ledger
 * rows are 40px, the record table keeps 36, and a dialog head is 48px on
 * bone.
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
      expect(classesOf(html, 'mono')).toContain('text-foreground')
    }
  })

  it('sets its count at the far right in mono ink, after the action', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(
      <SectionHead title="Tasks" count="5 · 2 overdue" action={<a>All</a>} />,
    )
    const band = doc.querySelector('body > div')
    const count = doc.querySelector('[data-section-count]')
    expect(count?.textContent).toBe('5 · 2 overdue')
    expect(count?.className.split(' ')).toEqual(
      expect.arrayContaining(['mono', 'text-micro', 'text-foreground']),
    )
    // Title first, then the right cluster, the count its last element.
    expect(band?.firstElementChild.textContent).toBe('Tasks')
    expect(band?.lastElementChild.lastElementChild).toBe(count)
    expect(band?.lastElementChild.firstElementChild.textContent).toBe('All')
  })

  it('carries a Segmented in place of the count, never both', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(
      <SectionHead
        title="Needs you"
        switch={
          <Segmented
            label="Kind"
            value="all"
            options={[
              { id: 'all', label: 'All' },
              { id: 'tasks', label: 'Tasks', count: 4 },
            ]}
            onChange={() => {}}
          />
        }
      />,
    )
    expect(doc.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(doc.querySelector('[data-section-count]')).toBeNull()
    // @ts-expect-error — the type makes the count and the switch exclusive.
    void (<SectionHead title="x" count="1" switch={null} />)
  })
})

describe('a label head', () => {
  it('labels in ink mono caps on paper, a hairline under', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(<LabelHead label="Companies" />)
    const head = doc.querySelector('body > div')
    expect(head?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-7',
        'bg-paper',
        'border-b',
        'border-hairline',
      ]),
    )
    expect(head?.querySelector('h2')?.className.split(' ')).toEqual(
      expect.arrayContaining(['label-caps', 'text-foreground']),
    )
  })
})

describe('a band', () => {
  it('is 28px of bone on a rule, its label mono caps graphite', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(<Band label="Tasks" />)
    const band = doc.querySelector('[data-band]')
    expect(band?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-7',
        'bg-bone',
        'border-b',
        'border-rule',
        'px-3',
      ]),
    )
    const label = band?.querySelector('h3')
    expect(label?.textContent).toBe('Tasks')
    expect(label?.className.split(' ')).toEqual(
      expect.arrayContaining(['label-caps', 'text-graphite']),
    )
    expect(band?.children).toHaveLength(1)
  })

  it('ends on its link in sans graphite when it has one', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(
      <Band label="Latest" link={<a href="#i">All interactions ›</a>} />,
    )
    const band = doc.querySelector('[data-band]')
    const link = band?.lastElementChild
    expect(link?.textContent).toBe('All interactions ›')
    expect(link?.className.split(' ')).toEqual(
      expect.arrayContaining(['text-label', 'text-graphite']),
    )
  })
})

describe('an empty row', () => {
  it('is the whole section: the name in graphite and a +, one button', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(
      <EmptyRow name="Tasks" onAdd={() => {}} />,
    )
    const row = doc.querySelector('[data-empty-row]')
    expect(row?.tagName).toBe('BUTTON')
    expect(row?.textContent).toBe('Tasks+')
    expect(row?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-row',
        'bg-bone',
        'text-ui',
        'text-graphite',
        'border-b',
        'border-rule',
      ]),
    )
    // The + is at the title size; the accessible name is the section's.
    const plus = row?.lastElementChild
    expect(plus?.getAttribute('aria-hidden')).toBe('true')
    expect(plus?.className).toContain('text-title')
    // No sentence, no 0.
    expect(row?.textContent).not.toMatch(/\d|\./)
  })

  it('takes a dialog trigger’s props, so it can open one', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(
      <EmptyRow name="Spaces" aria-haspopup="dialog" data-state="closed" />,
    )
    const row = doc.querySelector('[data-empty-row]')
    expect(row?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(row?.getAttribute('data-state')).toBe('closed')
  })
})

describe('a fold row', () => {
  it('is a 40px `n more` on a rule that unfolds the rest', () => {
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(
      <FoldRow hidden={25} onShow={() => {}} />,
    )
    const row = doc.querySelector('[data-fold-row]')
    expect(row?.tagName).toBe('BUTTON')
    expect(row?.textContent).toBe('25 more')
    expect(row?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-ledger-row',
        'border-t',
        'border-rule',
        'px-3',
        'text-label',
        'text-graphite',
      ]),
    )
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
