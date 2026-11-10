import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import * as icons from './icons'
import { LedgerRow, LedgerSection } from './ledger-section'
import { NewButton, SplitNewButton } from './new-button'
import {
  Card,
  FolderGround,
  PAGE_EDGE,
  PageBody,
  PageHeader,
} from './page-header'
import { ProviderMark, brandOf } from './provider-mark'
import { SettingsRow, SettingsSection } from './settings/settings-section'
import { ReadoutStrip, RecordBody, RecordHeader } from './record/record-parts'
import { Tabs } from './ui/tabs'

/**
 * The edges: a page meets its frame on one 24px line. The title sits on it,
 * and a card's content lands on it from the 12px gutter through the card's
 * 1px rule and 11px inset. The ground under the head is bone, every sheet on
 * it paper, and the page's tabbed object is its one ink folder. jsdom
 * measures nothing, so the geometry is proved by the classes and custom
 * properties that decide it.
 */

const src = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(join(src, 'styles.css'), 'utf8')
const read = (path: string) => readFileSync(join(src, path), 'utf8')

/** Tailwind's spacing step: `px-3` is 3 × 4px. */
const STEP_PX = 4

/** Every class on the first element carrying `marker`. */
function classesOf(html: string, marker: string): Array<string> {
  const match = new RegExp(`class="([^"]*\\b${marker}[^"]*)"`).exec(html)
  expect(match, marker).not.toBeNull()
  return (match?.[1] ?? '').split(/\s+/)
}

/** Every class on the first element whose tag carries `attr`. */
function classesAt(html: string, attr: string): Array<string> {
  const tag = new RegExp(`<[a-z]+\\b[^>]*${attr}[^>]*>`).exec(html)?.[0]
  expect(tag, attr).toBeDefined()
  return (/class="([^"]*)"/.exec(tag ?? '')?.[1] ?? '').split(/\s+/)
}

/** The px a padding class like `px-3` / `pr-2` / `p-3` stands for. */
function padPx(
  classes: ReadonlyArray<string>,
  side: 'p' | 'px' | 'pr' | 'pt',
): number {
  const hit = classes.find((c) => new RegExp(`^${side}-[\\d.]+$`).test(c))
  return hit === undefined ? 0 : Number(hit.split('-')[1]) * STEP_PX
}

/** A custom property's rem value as px, from the rule it is declared in. */
function remPx(block: string, prop: string): number {
  const m = new RegExp(`${prop}:\\s*([\\d.]+)rem`).exec(block)
  if (m === null) throw new Error(`no ${prop}`)
  return Number(m[1]) * 16
}

function sourceFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : []
  })
}

const cardBlock = /@utility card \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
const folderBlock = /@utility folder \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
const rootBlock = /:root \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''

/** The gutter, the 1px edge and the 11px inset: where a sheet's text lands. */
const GUTTER_PX = 12
const SHEET_EDGE = GUTTER_PX + 1 + remPx(cardBlock, '--inset')

const folderTabs = (trail?: ReactNode) => (
  <Tabs
    label="Views"
    items={[
      { id: 'all', label: 'All', count: 3 },
      { id: 'mine', label: 'Mine', count: 1 },
    ]}
    value="all"
    onValueChange={() => {}}
    {...(trail === undefined ? {} : { trail })}
  />
)

describe('E1 · the 24px edge', () => {
  it('puts the page title and the record name on it', () => {
    const head = classesOf(
      renderToStaticMarkup(<PageHeader title="Companies" />),
      'min-h-26',
    )
    expect(PAGE_EDGE).toBe('px-6')
    expect(padPx(head, 'px')).toBe(24)
    const record = classesOf(
      renderToStaticMarkup(
        <RecordHeader stamp={{ kind: 'Company' }} name="Flent" />,
      ),
      'pt-5',
    )
    expect(padPx(record, 'px')).toBe(24)
  })

  it('lands a card’s content on it: 12px gutter + 1px rule + 11px inset', () => {
    const html = renderToStaticMarkup(
      <PageBody>
        <Card>
          <LedgerSection label="Due" count="2">
            <LedgerRow>Chase the data room</LedgerRow>
          </LedgerSection>
        </Card>
        <Card>
          <LedgerSection label="Later">
            <LedgerRow>Re-mark</LedgerRow>
          </LedgerSection>
        </Card>
      </PageBody>,
    )
    const body = classesAt(html, 'data-page-body')
    expect(body).toEqual(expect.arrayContaining(['p-3', 'gap-3']))
    expect(padPx(body, 'p')).toBe(GUTTER_PX)
    // Two cards, 12px apart, each a `card` box.
    expect(html.match(/data-card="true"/g)).toHaveLength(2)
    expect(html.match(/class="[^"]*\bcard\b[^"]*"/g)).toHaveLength(2)
    // The head band and the row both inset by the card's `--inset`.
    expect(classesAt(html, 'data-section-head')).toContain('px-(--inset)')
    expect(classesOf(html, 'h-ledger-row')).toContain('px-(--inset)')
    expect(cardBlock).toMatch(/border: 1px solid var\(--rule\)/)
    expect(SHEET_EDGE).toBe(24)
    // Outside a card a row keeps the page's own 24px.
    expect(remPx(rootBlock, '--inset')).toBe(24)
    // A folder's body insets its rows the same 11px.
    expect(remPx(folderBlock, '--inset')).toBe(remPx(cardBlock, '--inset'))
  })

  it('puts a folder’s first tab label on the line from the gutter, its toolbar 24px from the right', () => {
    const html = renderToStaticMarkup(
      <FolderGround>{folderTabs(<span data-search />)}</FolderGround>,
    )
    const ground = classesOf(html, 'pt-3')
    const tab = classesOf(html, 'tab-open')
    // The ground's 12px gutter, then the tab's 12px: the label on 24.
    expect(padPx(ground, 'px') + padPx(tab, 'px')).toBe(24)
    const trail = classesOf(html, 'h-9 min-w-0')
    expect(padPx(ground, 'px') + padPx(trail, 'pr')).toBe(24)
  })

  it('sets every surface’s first text on the line: Today, a list, a record, Notes, Portfolio', () => {
    // Today: the day strip, the notices and the rail cards are rule cards
    // whose rows take the card's inset.
    for (const [file, marker] of [
      ['components/today/day-strip.tsx', 'data-day-strip'],
      ['components/today/notices.tsx', 'aria-label="Notices"'],
      ['components/today/rail.tsx', 'aria-label="Portfolio"'],
      ['components/today/rail.tsx', `aria-label="What's moving"`],
    ] as const) {
      const at = read(file).indexOf(marker)
      expect(at, `${file} ${marker}`).toBeGreaterThan(-1)
      expect(read(file).slice(at, at + 240), marker).toMatch(/\bcard\b/)
    }
    expect(read('components/today/day-strip.tsx')).toMatch(
      /h-16 shrink-0 card px-\(--inset\)/,
    )
    expect(read('components/today/rail.tsx')).toMatch(
      /h-7 shrink-0 items-center border-b border-rule px-\(--inset\) label-caps/,
    )
    // Today sits in one PageBody: 12px gutter, cards 12px apart.
    expect(read('routes/_app/today.tsx')).toContain('<PageBody>')
    // A list's table hangs from its bar inside the PageBody gutter.
    for (const list of ['companies', 'people', 'deals', 'files'])
      expect(read(`routes/_app/${list}.tsx`), list).toContain(
        '<PageBody className="pt-0">',
      )
    // Portfolio's figures are a boxed strip, its cells on the card inset.
    expect(read('components/portfolio-headline.tsx')).toContain(
      '<ReadoutStrip boxed',
    )
    const strip = renderToStaticMarkup(
      <ReadoutStrip boxed readouts={[{ label: 'Value', value: '$1M' }]} />,
    )
    expect(classesOf(strip, 'min-w-28')).toContain('px-(--inset)')
    // Notes: one card (or the folder's body) under This week and Earlier.
    expect(read('routes/_app/notes.tsx')).toMatch(/<Card label="Notes">/)
  })
})

describe('E2 · one rule under the head, the ··· on the content’s right edge', () => {
  it('closes the head on one 1px rule, never the double', () => {
    const html = renderToStaticMarkup(<PageHeader title="Notes" />)
    const head = classesOf(html, 'min-h-26')
    expect(head).toEqual(expect.arrayContaining(['border-b', 'border-rule']))
    expect(html).not.toContain('double-rule')
  })

  it('ends the head’s actions 24px in, where a folder bar’s last control ends', () => {
    // Proved by structure: the actions are the head's last flex child and
    // the head pads 24px; the ground pads 12px and the bar's tools 12px more.
    const html = renderToStaticMarkup(
      <PageHeader
        title="Companies"
        action={<button type="button">···</button>}
      />,
    )
    const head = classesOf(html, 'min-h-26')
    expect(head).toEqual(expect.arrayContaining(['flex', 'justify-between']))
    expect(html).toMatch(
      /data-head-actions-slot[^>]*>[\s\S]*<\/div><\/div><\/header>/,
    )
    expect(padPx(head, 'px')).toBe(GUTTER_PX + 12)
  })

  it('is spelled by no page under routes or components', () => {
    const hits = sourceFiles(src)
      .filter((f) => /\bdouble-rule\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f))
    expect(hits).toEqual([])
  })
})

describe('E9 · the ground is bone, the sheets are paper', () => {
  it('lays the bone ground under every app page but settings, and the head on paper', () => {
    const app = read('routes/_app.tsx')
    expect(app).toContain("data-ground={onSettings ? 'paper' : 'bone'}")
    expect(app).toContain("onSettings ? 'bg-paper' : 'bg-bone'")
    // The page fills the view, so the ground runs to its foot.
    expect(app).toMatch(/'flex min-w-0 flex-1 flex-col pt-12 \*:flex-1/)
    expect(
      classesOf(renderToStaticMarkup(<PageHeader title="Deals" />), 'min-h-26'),
    ).toContain('bg-paper')
    expect(
      classesOf(
        renderToStaticMarkup(
          <RecordHeader stamp={{ kind: 'Company' }} name="Flent" />,
        ),
        'pt-5',
      ),
    ).toContain('bg-paper')
    const body = classesAt(
      renderToStaticMarkup(<PageBody>x</PageBody>),
      'data-page-body',
    )
    expect(body).toEqual(expect.arrayContaining(['bg-bone', 'flex-1']))
  })

  it('makes every card paper, and a head that opens one its own paper head', () => {
    expect(cardBlock).toMatch(/background: var\(--paper\)/)
    // The section head that opens a card loses its bone and its top line.
    expect(cardBlock).toMatch(
      /\[data-section-head\]:first-child \{\s*border-top-width: 0;\s*background: var\(--paper\);/,
    )
    // In a folder a section head stays a bone band.
    expect(folderBlock).not.toMatch(
      /background: var\(--paper\);\s*\}\s*\n\s*& > ol/,
    )
  })

  it('carries bone on a bar pinned under the folded head, so nothing scrolls through the gutter', () => {
    const ground = classesOf(
      renderToStaticMarkup(<FolderGround pinned>x</FolderGround>),
      'pt-3',
    )
    expect(ground).toEqual(
      expect.arrayContaining(['bg-bone', 'sticky', 'md:top-12']),
    )
    const pinned = renderToStaticMarkup(
      <Tabs
        label="Record"
        pinned
        items={[{ id: 'a', label: 'A' }]}
        value="a"
        onValueChange={() => {}}
      />,
    )
    expect(classesAt(pinned, 'role="tablist"')).toContain('bg-bone')
  })

  it('turns Today’s rail into two paper cards: no bone rail, no ink edge', () => {
    const today = read('routes/_app/today.tsx')
    expect(today).toContain(
      '<aside className="flex w-full shrink-0 flex-col gap-3 xl:w-90">',
    )
    expect(today).not.toMatch(/bg-bone p-5/)
    expect(read('components/today/notices.tsx')).toContain(
      '<section aria-label="Notices" className="card">',
    )
  })
})

describe('E10 · one ink object on a page: the folder', () => {
  it('draws the bar on the ground with a hairline foot and the open tab joining the body', () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Record"
        items={[
          { id: 'a', label: 'Overview', uncounted: true },
          { id: 'b', label: 'Notes', count: 2 },
        ]}
        value="a"
        onValueChange={() => {}}
      >
        <p>Body</p>
      </Tabs>,
    )
    const bar = classesAt(html, 'role="tablist"')
    expect(bar).toEqual(
      expect.arrayContaining(['h-11', 'items-end', 'before:bg-hairline']),
    )
    expect(bar.some((c) => c.startsWith('bg-'))).toBe(false)
    // The open tab is a pixel taller and a pixel low, over the foot line.
    expect(classesOf(html, 'tab-open')).toEqual(
      expect.arrayContaining(['top-px', 'h-9.25']),
    )
    // The body is the folder: paper, hairline sides and foot, no top.
    expect(classesAt(html, 'role="tabpanel"')).toContain('folder')
    expect(folderBlock).toMatch(/border: 1px solid var\(--hairline\)/)
    expect(folderBlock).toMatch(/border-top-width: 0/)
    expect(folderBlock).toMatch(/background: var\(--paper\)/)
  })

  it('keeps an inner bar plain: a rule foot and a rule-edged open tab', () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Sheets"
        plain
        items={[{ id: 'a', label: 'Sheet1' }]}
        value="a"
        onValueChange={() => {}}
      />,
    )
    expect(html).toContain('before:bg-rule')
    expect(html).not.toContain('before:bg-hairline')
    expect(classesOf(html, 'tab-open')).toContain('tab-open-plain')
    expect(css).toMatch(
      /@utility tab-open-plain \{\s*--tab-edge: var\(--rule\);/,
    )
  })

  it('frames a list’s table as the folder and a tabless table as a rule card', () => {
    for (const list of [
      'companies',
      'people',
      'deals',
      'o.$objectSlug',
      'files',
    ])
      expect(read(`routes/_app/${list}.tsx`), list).toMatch(
        /<RecordTable\s+joined[^>]*?\n\s+folder\n/,
      )
    expect(read('routes/_app/portfolio.tsx')).not.toMatch(/\bfolder\b/)
    const table = read('components/table/record-table.tsx')
    expect(table).toContain("folder ? 'border-hairline' : 'border-rule'")
  })

  it('gives a tabbed page exactly one folder and a tabless page none', () => {
    // Pages whose tabs ride the head: one folder body under them.
    for (const [page, bodies] of [
      ['routes/_app/meetings.tsx', 1],
      ['routes/_app/notes.tsx', 1],
      ['routes/_app/review.tsx', 1],
    ] as const) {
      const n = read(page).match(/<FolderBody\b/g)?.length ?? 0
      expect(n, page).toBe(bodies)
    }
    // Notes and Review fall back to a card when they have no tabs.
    expect(read('routes/_app/notes.tsx')).toContain('<Card label="Notes">')
    expect(read('routes/_app/review.tsx')).toContain('<Card label="Review"')
    // Pages with no tab bar draw no hairline sheet.
    for (const page of [
      'routes/_app/portfolio.tsx',
      'routes/_app/tasks.tsx',
      'routes/_app/mandate.tsx',
      'components/spaces-index.tsx',
    ]) {
      const text = read(page)
      expect(text, page).not.toMatch(
        /FolderBody|\bfolder\b|border-hairline bg-paper/,
      )
    }
  })

  it('wears no hairline on a rule card: Review’s items, Spaces’ lane heads', () => {
    for (const file of [
      'routes/_app/review.tsx',
      'components/inbox/suggestion-card.tsx',
      'components/inbox/discovery-group.tsx',
      'components/inbox/column-run-group.tsx',
    ])
      expect(read(file), file).not.toMatch(/border border-hairline bg-paper/)
    expect(read('components/spaces-index.tsx')).not.toMatch(
      /data-lane-heads[\s\S]{0,80}border-hairline/,
    )
  })
})

describe('E11 · a record’s rail sits on the ground', () => {
  it('prints the rail on the bone with no box, on the 24px edge, and stands the folder to its right', () => {
    const html = renderToStaticMarkup(
      <RecordBody groups details={<p>Domains</p>}>
        <Tabs
          label="Flent"
          pinned
          items={[{ id: 'overview', label: 'Overview', uncounted: true }]}
          value="overview"
          onValueChange={() => {}}
        >
          <p>Overview</p>
        </Tabs>
      </RecordBody>,
    )
    const body = classesAt(html, 'data-record-body="details"')
    expect(body).toEqual(
      expect.arrayContaining(['bg-bone', 'p-3', 'gap-3', 'xl:flex-row']),
    )
    const rail = classesAt(html, 'data-record-rail')
    expect(rail).toContain('xl:w-80')
    expect(rail.some((c) => /^(bg-|border)/.test(c))).toBe(false)
    expect(padPx(body, 'p') + padPx(rail, 'px')).toBe(24)
    expect(html).toMatch(/role="tabpanel"[^>]*class="[^"]*\bfolder\b/)
  })
})

describe('the 32px gutter is gone', () => {
  it('appears in no route or page-level component', () => {
    const hits = sourceFiles(src)
      .filter((f) =>
        /(^|[\s'"`])px-8([\s'"`]|$)/m.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(src, f))
    expect(hits).toEqual([])
  })
})

describe('E4 · settings cap at 800px, left-aligned', () => {
  it('holds the section, its head and its Save bar in one 800px column on the 12px edge', () => {
    const shell = read('routes/_app/settings.tsx')
    expect(shell).toMatch(
      /className="box-content flex max-w-200 flex-col gap-12 px-3 /,
    )
    expect(shell).not.toMatch(/mx-auto/)
    expect(read('components/settings/settings-form.tsx')).toMatch(
      /box-content flex h-12 max-w-200 items-center gap-3 px-3/,
    )
    // 50rem: 800px of content, with the 12px edge outside it.
    expect(50 * 16).toBe(800)
  })

  it('puts the head’s action and the rows in that one column, with no padding of their own', () => {
    const html = renderToStaticMarkup(
      <SettingsSection
        title="Currency"
        crumb="Workspace"
        action={<button type="button">Add rate</button>}
      >
        <SettingsRow label="Base">
          <button type="button">USD</button>
        </SettingsRow>
      </SettingsSection>,
    )
    const head = classesOf(html, 'pb-2.5')
    expect(head).toEqual(
      expect.arrayContaining(['justify-between', 'border-b', 'border-rule']),
    )
    expect(head.some((c) => /^p[xr]-/.test(c))).toBe(false)
    const row = classesOf(html, 'min-h-12')
    expect(row.some((c) => /^p[xr]-/.test(c))).toBe(false)
  })

  it('keeps lists full width: no cap on a list route', () => {
    for (const list of ['companies', 'people', 'deals', 'files', 'portfolio']) {
      expect(read(`routes/_app/${list}.tsx`), list).not.toMatch(/max-w-200/)
    }
  })
})

describe('E6 · every create is + New x, in pine', () => {
  it('draws `+ New x` as the primary with the new glyph', () => {
    const html = renderToStaticMarkup(<NewButton noun="company" />)
    expect(html).toContain('data-variant="default"')
    expect(html).toMatch(/<svg[^>]*lucide-plus/)
    expect(html).toMatch(/>New company<\/button>$/)
  })

  it('splits Notes and Spaces, `▾` holding the templates', () => {
    const html = renderToStaticMarkup(
      <SplitNewButton
        noun="note"
        onNew={() => {}}
        templates={(trigger) => <span data-picker>{trigger}</span>}
      />,
    )
    expect(html).toContain('data-split-new')
    expect(html).toMatch(
      /data-picker[^>]*><button[^>]*aria-label="New note from a template"/,
    )
    expect(read('routes/_app/notes.tsx')).toMatch(
      /<SplitNewButton\s+noun="note"/,
    )
    expect(read('components/spaces-index.tsx')).toMatch(
      /<SplitNewButton\s+noun="space"/,
    )
    // The Spaces composer row is gone: the head's split is the way in.
    expect(read('components/spaces-index.tsx')).not.toContain(
      'data-composer-row',
    )
  })

  it('is the default trigger of every create window', () => {
    for (const [file, noun] of [
      ['components/create-company-dialog.tsx', '"company"'],
      ['components/create-person-dialog.tsx', '"person"'],
      ['components/create-deal-dialog.tsx', '"deal"'],
      ['components/create-record-dialog.tsx', '{singular}'],
      ['components/task-composer.tsx', '"task"'],
    ]) {
      expect(read(file), file).toContain(`<NewButton noun=${noun}`)
    }
  })

  it('reads Upload on Files and Record a check, filled, on Portfolio', () => {
    const files = read('routes/_app/files.tsx')
    expect(files).toMatch(/<icon\.upload[^>]*\/>\s*Upload\s*<\/Button>/)
    expect(files).not.toContain('NewButton')
    expect(read('routes/_app/portfolio.tsx')).toContain(
      'trigger={<Button>Record a check</Button>}',
    )
  })

  it('keeps Tasks’ head button, which hands off to the composer row', () => {
    const tasks = read('routes/_app/tasks.tsx')
    expect(tasks).toMatch(/<NewButton\s+noun="task"/)
    expect(tasks).toContain("'[data-composer-row]'")
  })
})

describe('E7 · one icon list, one brand mark', () => {
  it('is the only lucide-react import in the app', () => {
    const importers = sourceFiles(src)
      .filter((f) => /from ['"]lucide-react['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f))
    expect(importers).toEqual(['components/icons.ts'])
  })

  it('maps each verb to one glyph and does not hand a verb glyph out by name', () => {
    for (const verb of [
      'new',
      'import',
      'filter',
      'sort',
      'columns',
      'search',
      'open',
      'upload',
      'enrich',
      'archive',
      'more',
    ] as const)
      expect(icons.icon[verb], verb).toBeDefined()
    for (const name of [
      'Plus',
      'X',
      'Trash2',
      'Upload',
      'Archive',
      'Search',
      'ListFilter',
      'ArrowUpDown',
      'Columns3',
      'Ellipsis',
      'Sparkles',
    ])
      expect(name in icons, name).toBe(false)
  })

  it('draws a brand only through ProviderMark, monochrome', () => {
    const html = renderToStaticMarkup(<ProviderMark brand="googleDrive" />)
    expect(html).toContain('fill="currentColor"')
    expect(html).toContain('aria-label="Google Drive"')
    expect(renderToStaticMarkup(<ProviderMark brand="granola" />)).toContain(
      '>G</text>',
    )
    expect(brandOf('Apollo.io')).toBe('apollo')
    expect(brandOf('google-drive')).toBe('googleDrive')
    expect(brandOf('Echo')).toBeNull()
    // No other file spells a brand's colours or draws an inline logo.
    const brandColour = /#(4285f4|34a853|fbbc04|ea4335|0061d5|0066da)/i
    const drawers = sourceFiles(src)
      .filter((f) => brandColour.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f))
    expect(drawers).toEqual([])
    const svgs = sourceFiles(src)
      .filter((f) => readFileSync(f, 'utf8').includes('<svg'))
      .map((f) => relative(src, f))
      .sort()
    // Each of these draws data or our own concept, never a logo.
    expect(svgs).toEqual([
      'components/dither.tsx',
      'components/files/file-glyph.tsx',
      'components/files/file-row.tsx',
      'components/ledger-section.tsx',
      'components/note-kind-icon.tsx',
      'components/provider-mark.tsx',
      'components/record/record-parts.tsx',
      'components/space-overview.tsx',
      'components/today/day-strip.tsx',
      'components/twinkle.tsx',
      'components/wordmark.tsx',
      'lib/email/sanitize.ts',
      'lib/members/workspace-logo-file.ts',
    ])
  })
})

describe('E8 · a date band carries no count', () => {
  it('bands the Notes list with no count', () => {
    const notes = read('routes/_app/notes.tsx')
    expect(notes).toMatch(/<Band label="This week" \/>/)
    expect(notes).toMatch(/<Band label="Earlier" \/>/)
  })
})
