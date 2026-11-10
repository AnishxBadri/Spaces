import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import * as icons from './icons'
import { LedgerRow, LedgerSection } from './ledger-section'
import { NewButton, SplitNewButton } from './new-button'
import { Card, PAGE_EDGE, PageBody, PageHeader } from './page-header'
import { ProviderMark, brandOf } from './provider-mark'
import { SettingsRow, SettingsSection } from './settings/settings-section'
import { Tabs } from './ui/tabs'

/**
 * The edges: a page meets its frame on one 12px line. The title sits on it,
 * and a card's content lands on it from the 4px gutter through the card's
 * 1px rule and 7px inset. jsdom measures nothing, so the geometry is proved
 * by the classes and custom properties that decide it.
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

/** The px a padding class like `px-3` / `pr-2` / `px-1.75` stands for. */
function padPx(classes: ReadonlyArray<string>, side: 'px' | 'pr'): number {
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
const rootBlock = /:root \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''

describe('E1 · the 12px edge', () => {
  it('puts the page title on it', () => {
    const html = renderToStaticMarkup(<PageHeader title="Companies" />)
    const head = classesOf(html, 'min-h-26')
    expect(PAGE_EDGE).toBe('px-3')
    expect(padPx(head, 'px')).toBe(12)
  })

  it('lands a card’s content on it: 4px gutter + 1px rule + 7px inset', () => {
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
    const body = classesOf(html, 'gap-1')
    expect(body).toEqual(expect.arrayContaining(['px-1', 'gap-1']))
    // Two cards, 4px apart, each a `card` box.
    expect(html.match(/data-card="true"/g)).toHaveLength(2)
    expect(html.match(/class="[^"]*\bcard\b[^"]*"/g)).toHaveLength(2)
    // The head band and the row both inset by the card's `--inset`.
    expect(classesOf(html, 'bg-bone')).toContain('px-(--inset)')
    expect(classesOf(html, 'h-ledger-row')).toContain('px-(--inset)')
    expect(cardBlock).toMatch(/border: 1px solid var\(--rule\)/)
    const gutter = padPx(body, 'px')
    const rule = 1
    const inset = remPx(cardBlock, '--inset')
    expect(gutter + rule + inset).toBe(12)
    // Outside a card a row keeps the page's own 12px.
    expect(remPx(rootBlock, '--inset')).toBe(12)
  })

  it('keeps a list’s first tab label on the same line, and its toolbar 12px from the right', () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Views"
        items={[{ id: 'all', label: 'All', count: 3 }]}
        value="all"
        onValueChange={() => {}}
        trail={<span data-search />}
      />,
    )
    const bar = classesOf(html, 'before:bg-rule')
    const tab = classesOf(html, 'tab-open')
    // The bar's 4px gutter, then the tab's 8px: the label on 12.
    expect(padPx(bar, 'px') + padPx(tab, 'px')).toBe(12)
    // Its rule spans the card below, not the page.
    expect(bar).toContain('before:inset-x-1')
    const trail = classesOf(html, 'self-stretch')
    expect(padPx(bar, 'px') + padPx(trail, 'pr')).toBe(12)
  })
})

describe('E2 · one rule under the head, the ··· on the content’s right edge', () => {
  it('closes the head on one 1px rule, never the double', () => {
    const html = renderToStaticMarkup(<PageHeader title="Notes" />)
    const head = classesOf(html, 'min-h-26')
    expect(head).toEqual(expect.arrayContaining(['border-b', 'border-rule']))
    expect(html).not.toContain('double-rule')
  })

  it('ends the head’s actions 12px in, where a list bar’s last control ends', () => {
    // Proved by structure: the actions are the head's last flex child and
    // the head pads 12px; the bar pads 4px and its tools 8px more.
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
    expect(padPx(head, 'px')).toBe(4 + 8)
  })

  it('is spelled by no page under routes or components', () => {
    const hits = sourceFiles(src)
      .filter((f) => /\bdouble-rule\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f))
    expect(hits).toEqual([])
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
