import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SheetTabs } from './import/import-wizard.tsx'
import { LedgerSection, SectionHead } from './ledger-section.tsx'
import { PageHeader, ReadoutStrip } from './page-header.tsx'
import {
  RailSection,
  RecordHeader,
  RecordSection,
} from './record/record-parts.tsx'
import { DialogHeader } from './ui/dialog.tsx'
import { Stamp, spaceStamp } from './ui/stamp.tsx'
import { Tabs, nextTabIndex } from './ui/tabs.tsx'
import type { TabItem } from './ui/tabs.tsx'

/**
 * The printed details as the primitives draw them: the double rule under a
 * page or record head and nowhere else, one ink stamp per page (outlined
 * when archived), and real tabs whose open tab joins the body.
 */

const src = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(join(src, 'styles.css'), 'utf8')

/** Every class on the first element carrying `marker`. */
function classesOf(html: string, marker: string): Array<string> {
  const match = new RegExp(`class="([^"]*\\b${marker}\\b[^"]*)"`).exec(html)
  expect(match, marker).not.toBeNull()
  return (match?.[1] ?? '').split(/\s+/)
}

function count(html: string, re: RegExp): number {
  return html.match(re)?.length ?? 0
}

/** The `<header>` itself, without the folded bar that hangs before it. */
function headOf(html: string): string {
  return html.slice(html.indexOf('<header'))
}

function tsxFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

const companyStamp = { kind: 'Company', fact: '3f2a9c1b' }

describe('the double rule', () => {
  it('is a named utility: 2px ink, 2px gap, 1px ink', () => {
    expect(css).toMatch(/@utility double-rule \{[^}]*border-bottom: 5px/)
  })

  it('draws under every page head and record head, in place of the hairline', () => {
    for (const html of [
      renderToStaticMarkup(<PageHeader title="Companies" />),
      renderToStaticMarkup(
        <RecordHeader stamp={companyStamp} crumb="Companies" name="Flent" />,
      ),
    ]) {
      const head = classesOf(html, 'double-rule')
      expect(head).not.toContain('border-b')
      expect(html).toMatch(/<header class="[^"]*\bdouble-rule\b/)
    }
  })

  it('never draws under a section head, a dialog head, a rail or a readout strip', () => {
    for (const html of [
      renderToStaticMarkup(<SectionHead title="Files" count="3" />),
      renderToStaticMarkup(
        <LedgerSection label="Due" count="2">
          {null}
        </LedgerSection>,
      ),
      renderToStaticMarkup(
        <RecordSection label="Notes" meta="4">
          {null}
        </RecordSection>,
      ),
      renderToStaticMarkup(
        <RailSection label="People" meta="2">
          {null}
        </RailSection>,
      ),
      renderToStaticMarkup(<DialogHeader>Head</DialogHeader>),
      renderToStaticMarkup(
        <ReadoutStrip cells={[{ label: 'Open', value: 3 }]} />,
      ),
    ]) {
      expect(html).not.toContain('double-rule')
    }
  })

  it('is spelled only by the page head and the record head', () => {
    const spelling = tsxFiles(src)
      .filter((f) => readFileSync(f, 'utf8').includes('double-rule'))
      .map((f) => relative(src, f))
      .sort()
    expect(spelling).toEqual([
      'components/page-header.tsx',
      'components/record/record-parts.tsx',
    ])
  })
})

describe('the ink stamp', () => {
  it('is a cut-end label from styles.css, and no tsx spells a clip-path', () => {
    expect(css).toMatch(/@utility stamp \{[^}]*clip-path: polygon/)
    expect(css).toMatch(/@utility stamp-outline \{/)
    for (const f of tsxFiles(src)) {
      expect(readFileSync(f, 'utf8'), relative(src, f)).not.toMatch(
        /clip-path|clip-\[/,
      )
    }
  })

  it('names the kind and one fact in ink', () => {
    const html = renderToStaticMarkup(<Stamp {...companyStamp} />)
    expect(classesOf(html, 'stamp')).not.toContain('stamp-outline')
    expect(html.replace(/<!-- -->/g, '')).toContain('Company 3f2a9c1b')
  })

  it('turns to outline with the day when archived', () => {
    const html = renderToStaticMarkup(
      <Stamp {...companyStamp} archivedOn="2026-10-08T14:02:00.000Z" />,
    )
    expect(classesOf(html, 'stamp')).toContain('stamp-outline')
    expect(html).toContain('data-stamp="archived"')
    expect(html.replace(/<!-- -->/g, '')).toContain('archived 10-08')
  })

  it('stamps a record head once, beside the crumb', () => {
    const html = renderToStaticMarkup(
      <RecordHeader
        stamp={companyStamp}
        crumb={<span data-crumb>Companies</span>}
        name="Flent"
      />,
    )
    expect(count(headOf(html), /data-stamp=/g)).toBe(1)
    // The stamp and the crumb share the head's first row.
    expect(headOf(html)).toMatch(/data-stamp="live"[^]*data-crumb[^]*<h1/)
  })

  it('stamps a space head once with its depth', () => {
    const html = renderToStaticMarkup(
      <RecordHeader
        stamp={spaceStamp(2)}
        crumb="Spaces / Fintech / Payments"
        name="Cross-border"
      />,
    )
    expect(count(headOf(html), /data-stamp=/g)).toBe(1)
    expect(html.replace(/<!-- -->/g, '')).toContain('Space · depth 2')
  })
})

describe('real tabs', () => {
  type Id = 'notes' | 'files' | 'people'
  const items: Array<TabItem<Id>> = [
    { id: 'notes', label: 'Notes', count: 4 },
    { id: 'files', label: 'Files', count: 0 },
    { id: 'people', label: 'People', count: 2 },
  ]

  function render(value: Id, body = true) {
    return renderToStaticMarkup(
      <Tabs label="Record" items={items} value={value} onValueChange={() => {}}>
        {body ? <p>Body</p> : undefined}
      </Tabs>,
    )
  }

  it('is a tablist with exactly one selected tab, in the tab order alone', () => {
    const html = render('notes')
    expect(html).toContain('role="tablist"')
    expect(count(html, /role="tab"/g)).toBe(3)
    expect(count(html, /aria-selected="true"/g)).toBe(1)
    expect(count(html, /aria-selected="false"/g)).toBe(2)
    expect(count(html, /tabindex="0"/g)).toBe(1)
    expect(count(html, /tabindex="-1"/g)).toBe(2)
  })

  it('draws the open tab in paper over the bar foot, the rest on bone', () => {
    const html = render('people')
    const bar = classesOf(html, 'bg-bone')
    expect(bar).toEqual(expect.arrayContaining(['border-b', 'border-hairline']))
    expect(count(html, /\btab-open\b/g)).toBe(1)
    const open = classesOf(html, 'tab-open')
    // Pulled 1px over the bar's foot: no rule under the open tab.
    expect(open).toContain('-mb-px')
    expect(open).not.toContain('border-b')
    expect(html).toMatch(/aria-selected="true"[^>]*class="[^"]*tab-open/)
  })

  it('keeps an empty tab visible, graphite at 0', () => {
    const html = render('notes')
    expect(html).toMatch(/Files<span data-tab-count="true" class="[^"]*">0</)
    const counts = [
      ...html.matchAll(/data-tab-count="true" class="([^"]*)">(\d+)</g),
    ].map((m) => ({ cls: m[1], n: m[2] }))
    expect(counts.map((c) => c.n)).toEqual(['4', '0', '2'])
    expect(counts[0]?.cls).toContain('text-foreground')
    expect(counts[1]?.cls).toContain('text-graphite')
  })

  it('ties the body to the open tab', () => {
    const html = render('files')
    const panel = /role="tabpanel" id="([^"]+)" aria-labelledby="([^"]+)"/.exec(
      html,
    )
    expect(panel).not.toBeNull()
    expect(html).toContain(`aria-controls="${panel?.[1]}"`)
    expect(html).toMatch(
      new RegExp(`id="${panel?.[2]}"[^>]*aria-selected="true"`),
    )
    expect(render('files', false)).not.toContain('tabpanel')
  })

  it('answers ← → with wrap, Home and End, and nothing else', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0)
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(nextTabIndex('ArrowLeft', 2, 3)).toBe(1)
    expect(nextTabIndex('Home', 2, 3)).toBe(0)
    expect(nextTabIndex('End', 0, 3)).toBe(2)
    expect(nextTabIndex('ArrowDown', 0, 3)).toBeNull()
    expect(nextTabIndex('Enter', 0, 3)).toBeNull()
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull()
  })

  it('is a styles.css shape, not a clip-path in the tsx', () => {
    expect(css).toMatch(/@utility tab-open \{[^}]*clip-path: polygon/)
  })
})

describe('the import wizard sheet tabs', () => {
  it('render through Tabs', () => {
    const html = renderToStaticMarkup(
      <SheetTabs
        sheets={['Holdings', 'Marks']}
        current="Marks"
        onSelect={() => {}}
        disabled={false}
      />,
    )
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Sheets"')
    expect(html).toMatch(
      /aria-selected="true"[^>]*class="[^"]*tab-open[^>]*>Marks</,
    )
    expect(html).not.toContain('tabpanel')
  })

  it('draw nothing for a single sheet', () => {
    expect(
      renderToStaticMarkup(
        <SheetTabs
          sheets={['Only']}
          current="Only"
          onSelect={() => {}}
          disabled={false}
        />,
      ),
    ).toBe('')
  })
})
