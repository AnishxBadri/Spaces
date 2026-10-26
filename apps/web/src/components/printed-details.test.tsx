import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SheetTabs } from './import/import-wizard.tsx'
import { LedgerSection, SectionHead } from './ledger-section.tsx'
import { HeadCount, PageHeader } from './page-header.tsx'
import {
  RailSection,
  ReadoutStrip,
  RecordHeader,
  RecordSection,
  countReadout,
} from './record/record-parts.tsx'
import { DialogHeader } from './ui/dialog.tsx'
import { Stamp, spaceStamp } from './ui/stamp.tsx'
import { ClockProvider } from './clock.tsx'
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

const companyStamp = { kind: 'Company' }

/** The instant the dates on these sheets are printed against. */
const NOW = '2026-10-26T12:00:00.000Z'

describe('the double rule', () => {
  it('is a named utility: 2px ink, 2px gap, 1px ink', () => {
    expect(css).toMatch(/@utility double-rule \{[^}]*border-bottom: 5px/)
  })

  it('draws under every page head and record head, in place of the hairline', () => {
    for (const html of [
      renderToStaticMarkup(<PageHeader title="Companies" />),
      renderToStaticMarkup(<RecordHeader stamp={companyStamp} name="Flent" />),
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
        <ReadoutStrip readouts={[{ label: 'Open', value: '3' }]} />,
      ),
    ]) {
      expect(html).not.toContain('double-rule')
    }
  })

  it('is spelled only by the page head, the record head and the settings head', () => {
    const spelling = tsxFiles(src)
      .filter((f) => readFileSync(f, 'utf8').includes('double-rule'))
      .map((f) => relative(src, f))
      .sort()
    expect(spelling).toEqual([
      'components/page-header.tsx',
      'components/record/record-parts.tsx',
      'components/settings/settings-section.tsx',
    ])
  })
})

describe('the readout strip', () => {
  it('is the record strip alone: page-header draws none of its own', () => {
    const header = readFileSync(join(src, 'components/page-header.tsx'), 'utf8')
    expect(header).not.toMatch(/function ReadoutStrip/)
  })

  it('reads a zero count graphite and colours only a nonzero one', () => {
    expect(countReadout({ label: 'Failed', value: 0, tone: 'bad' })).toEqual({
      label: 'Failed',
      value: '0',
      tone: 'muted',
    })
    expect(countReadout({ label: 'Failed', value: 2, tone: 'bad' })).toEqual({
      label: 'Failed',
      value: '2',
      tone: 'bad',
    })
    const html = renderToStaticMarkup(
      <ReadoutStrip
        readouts={[
          countReadout({ label: 'Create', value: 4 }),
          countReadout({ label: 'Collide', value: 0, tone: 'warn' }),
        ]}
      />,
    )
    // The number over a sentence-case label, never the mono field label.
    expect(html).not.toContain('field-label')
    expect(html).toMatch(/text-foreground[^>]*>4</)
    expect(html).toMatch(/text-graphite[^>]*>0</)
  })
})

describe('the ink stamp', () => {
  /** The `@utility <name> { … }` block from styles.css. */
  function utility(name: string): string {
    const at = css.indexOf(`@utility ${name} {`)
    expect(at, name).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('\n}', at))
  }

  it('is a plain 22px ink rectangle from styles.css, and nothing spells a clip-path', () => {
    const stamp = utility('stamp')
    expect(stamp).not.toMatch(/clip-path/)
    expect(stamp).toMatch(/height: 1\.375rem/)
    expect(stamp).toMatch(/padding-inline: 0\.625rem/)
    expect(stamp).toMatch(/line-height: 0\.875rem/)
    expect(stamp).toMatch(/text-transform: uppercase/)
    expect(stamp).toMatch(/font-weight: 500/)
    expect(stamp).toMatch(/background: var\(--hairline\)/)
    expect(stamp).toMatch(/color: var\(--paper\)/)
    expect(utility('stamp-outline')).not.toMatch(/clip-path|::before/)
    for (const f of tsxFiles(src)) {
      expect(readFileSync(f, 'utf8'), relative(src, f)).not.toMatch(
        /clip-path|clip-\[/,
      )
    }
  })

  it('names the kind alone, in ink', () => {
    const html = renderToStaticMarkup(<Stamp {...companyStamp} />)
    expect(classesOf(html, 'stamp')).not.toContain('stamp-outline')
    expect(html).toBe('<span data-stamp="live" class="stamp">Company</span>')
  })

  it('appends a lock and Sensitive when sensitive', () => {
    const html = renderToStaticMarkup(
      <Stamp kind="Company" state="sensitive" />,
    )
    expect(html).toContain('data-stamp="sensitive"')
    expect(html).toMatch(/>Company<svg[^>]*aria-hidden="true"[^]*Sensitive</)
  })

  it('turns to outline with Archived and the day when archived', () => {
    const html = renderToStaticMarkup(
      <ClockProvider now={NOW}>
        <Stamp
          kind="Company"
          state="archived"
          archivedOn="2026-10-08T14:02:00.000Z"
        />
      </ClockProvider>,
    )
    expect(classesOf(html, 'stamp')).toContain('stamp-outline')
    expect(html).toContain('data-stamp="archived"')
    // The day keeps its case inside the caps stamp: `ARCHIVED 8 Oct`.
    expect(html).toMatch(/Archived<span class="normal-case">8 Oct</)
  })

  it('stamps a record head once, alone on the row above the name', () => {
    const html = renderToStaticMarkup(
      <RecordHeader
        stamp={companyStamp}
        name="Flent"
        suffix={{ path: 'Companies' }}
      />,
    )
    const head = headOf(html)
    expect(count(head, /data-stamp=/g)).toBe(1)
    // The stamp row holds the stamp and nothing else, before the h1's row.
    expect(head).toMatch(
      /<div data-stamp-row="true" class="flex"><span data-stamp="live" class="stamp">Company<\/span><\/div><div/,
    )
    expect(head.indexOf('data-stamp-row')).toBeLessThan(head.indexOf('<h1'))
    // No heading in the stamp row: the h1 is the head's first heading.
    expect(head.slice(0, head.indexOf('<h1'))).not.toMatch(/<h[1-6]/)
  })

  it('prints a parent path in mono and a role in sans after the name', () => {
    const path = headOf(
      renderToStaticMarkup(
        <RecordHeader
          stamp={spaceStamp()}
          name="Payments"
          suffix={{ path: 'Spaces / Fintech' }}
        />,
      ),
    )
    expect(path).toMatch(
      /<\/h1><span data-suffix="true" class="[^"]*\bmono text-micro\b[^"]*">Spaces \/ Fintech</,
    )
    const role = headOf(
      renderToStaticMarkup(
        <RecordHeader
          stamp={{ kind: 'Person' }}
          name="Priya"
          suffix={{ role: 'Partner · Flent' }}
        />,
      ),
    )
    expect(classesOf(role, 'text-ui')).toContain('text-graphite')
    expect(role).not.toMatch(/data-suffix[^>]*mono/)
  })

  it('draws no readout strip and no crumb, and bottom-aligns the actions with the name', () => {
    const html = renderToStaticMarkup(
      <RecordHeader
        stamp={companyStamp}
        name="Flent"
        actions={<button type="button">Log interaction</button>}
      />,
    )
    expect(html).not.toContain('data-readouts')
    expect(headOf(html)).toMatch(
      /class="flex items-end justify-between gap-2"><div[^]*<h1[^]*data-head-actions-slot/,
    )
  })

  it('stamps a space head SPACE, with no depth', () => {
    const html = renderToStaticMarkup(
      <RecordHeader stamp={spaceStamp()} name="Cross-border" />,
    )
    expect(count(headOf(html), /data-stamp=/g)).toBe(1)
    expect(html).toContain('class="stamp">Space</span>')
    expect(html).not.toContain('depth')
  })

  it('draws an archived space head in outline, the name and the double rule graphite', () => {
    const html = renderToStaticMarkup(
      <ClockProvider now={NOW}>
        <RecordHeader
          stamp={spaceStamp('2026-10-08T09:00:00.000Z')}
          archived
          name="Small-lift"
        />
      </ClockProvider>,
    )
    expect(html).toMatch(/<header class="[^"]*\bdouble-rule-archived\b/)
    expect(headOf(html)).toContain('data-stamp="archived"')
    expect(html).toContain('8 Oct')
    expect(html).toMatch(
      /<h1[^>]*class="[^"]*\btext-graphite\b[^"]*"[^>]*>Small-lift/,
    )
  })
})

describe('the page head', () => {
  it('has no count of its own; a page with no tab bar puts it in the title', () => {
    const html = renderToStaticMarkup(
      <PageHeader title={<HeadCount title="Portfolio" count={1204} />} />,
    )
    expect(html).toMatch(
      /<h1[^>]*><span[^>]*>Portfolio<span data-head-count="true"[^>]*>1,204<\/span>/,
    )
    // @ts-expect-error The prop is gone: the count is the All tab's.
    renderToStaticMarkup(<PageHeader title="Companies" count={3} />)
  })

  it('hangs its Tabs bar under the head, pinned, with no chrome of its own', () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Review" tabs={<div data-bar>Tabs</div>} />,
    )
    const wrap = classesOf(html, 'top-22')
    expect(wrap).toEqual(
      expect.arrayContaining(['shrink-0', 'sticky', 'z-sticky', 'md:top-10']),
    )
    expect(wrap).not.toContain('border-b')
    expect(wrap).not.toContain('h-10')
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
    // A pixel taller and a pixel low, over the bar's foot: no rule under
    // the open tab.
    expect(open).toEqual(expect.arrayContaining(['h-10', 'top-px']))
    expect(open).not.toContain('border-b')
    expect(html).toMatch(/aria-selected="true"[^>]*class="[^"]*tab-open/)
  })

  it('keeps an empty tab visible, graphite with no count', () => {
    const html = render('notes')
    expect(html).toMatch(/>Files<\/button>/)
    const counts = [
      ...html.matchAll(/data-tab-count="true" class="([^"]*)">(\d+)</g),
    ].map((m) => ({ cls: m[1], n: m[2] }))
    expect(counts.map((c) => c.n)).toEqual(['4', '2'])
    for (const c of counts) expect(c.cls).toContain('text-foreground')
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

  it('is a styles.css shape, not drawn in the tsx', () => {
    expect(css).toMatch(/@utility tab-open \{/)
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
