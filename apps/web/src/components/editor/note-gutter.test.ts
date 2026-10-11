import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { NOTE_INSET } from './note-column'
import { cn } from '#/lib/utils'
import { declared } from '#/test/tailwind-css'

/**
 * The note editor's side menu (`+` and the drag handle) against the chassis.
 * BlockNote floats the menu left of the hovered block, so its left edge is
 * the block's left edge minus the menu's width. Two guards keep it off the
 * sidebar at every width the sidebar shows at (1440 and 1100 included):
 * - a note page's columns start at `NOTE_INSET`, at least the menu's width,
 *   and the editor adds no inset of its own — so the menu stays inside the
 *   page and the title, the filing rows and the body share one left edge;
 * - the chassis is its own stacking context on the z-scale, so a layer from
 *   `main` cannot paint over it even if one does cross.
 */

vi.mock('#/lib/server-fns', () => ({ listPinnedViews: vi.fn() }))

const src = fileURLToPath(new URL('../..', import.meta.url))
const read = (path: string) => readFileSync(`${src}/${path}`, 'utf8')
const css = read('styles.css')
const shell = read('routes/_app.tsx')
const notePage = read('routes/_app/notes_.$noteId.tsx')
const mandatePage = read('routes/_app/mandate.tsx')

/** The side menu's width, as measured in the browser at 1440 and 1100. */
const SIDE_MENU_PX = 48
const REM_PX = 16

/** The body of the first top-level rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `no ${selector} rule in styles.css`).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('\n}', start))
}

/** The source from `from` up to (not including) `to`, both required. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  expect(start, `no ${from}`).toBeGreaterThan(-1)
  const end = text.indexOf(to, start)
  expect(end, `no ${to} after ${from}`).toBeGreaterThan(start)
  return text.slice(start, end)
}

/** A left inset spelled in a class string: what would move one column's
 *  left edge off the others. */
const LEFT_INSET = /(?:^|[\s'"])-?(?:px|pl|ps|mx|ml|ms)-[\w[(]/

describe('the note inset', () => {
  it('is at least the side menu’s width', () => {
    const m = /--note-gutter:\s*([\d.]+)rem;/.exec(rule(':root'))
    expect(m, '--note-gutter in rem on :root').not.toBeNull()
    expect(Number(m?.[1]) * REM_PX).toBeGreaterThanOrEqual(SIDE_MENU_PX)
  })

  it('compiles to the gutter as the left padding', async () => {
    expect(await declared(NOTE_INSET, 'padding-left')).toEqual([
      'var(--note-gutter)',
    ])
  })

  it('survives a page column’s own px-8 under cn', () => {
    expect(cn('px-8 pt-7', NOTE_INSET).split(' ')).toContain(NOTE_INSET)
  })

  it('is the only inset: the editor and its wrapper add none', () => {
    expect(css).not.toMatch(/\n\.prose-note\s*\{/)
    expect(rule('.prose-note .bn-editor')).toContain('padding-inline: 0;')
    for (const page of [notePage, mandatePage]) {
      const wrapper = /className="(prose-note[^"]*)"/.exec(page)
      expect(wrapper).not.toBeNull()
      expect(wrapper?.[1]).not.toMatch(LEFT_INSET)
    }
  })
})

describe('a note page: the body columns share the inset', () => {
  it('on /notes/$id, the back link’s bar and the title-to-body column', () => {
    const bar = between(notePage, 'border-b border-hairline pr-8', '<Link')
    expect(bar).toContain('NOTE_INSET')
    // One column holds the title, both filing rows and the editor.
    const column = between(
      notePage,
      "cn('max-w-[72ch] pt-6 pr-8 pb-8', NOTE_INSET)",
      '<NoteEditor',
    )
    for (const part of [
      'aria-label="Note title"',
      '<SpaceFiling',
      '<RecordFiling',
      'prose-note',
    ])
      expect(column).toContain(part)
    // Nothing between them moves one of the three off that edge.
    expect(column.slice(column.indexOf('>'))).not.toMatch(LEFT_INSET)
  })

  it('on /mandate, the facts and the prose; the head keeps the page edge', () => {
    const head = between(
      mandatePage,
      '<PageHeader\n        title="Mandate"',
      '/>',
    )
    // The title sits at the 32px page edge like every other page's.
    expect(head).not.toContain('NOTE_INSET')
    expect(head).not.toContain('className={')
    const facts = between(mandatePage, 'function FactsGrid', '</div>')
    expect(facts).toContain(
      "'flex shrink-0 flex-col border-b border-hairline pr-8'",
    )
    expect(facts).toContain('NOTE_INSET')
    const prose = between(
      mandatePage,
      "cn('pt-6 pr-8 pb-8', NOTE_INSET)",
      '</div>',
    )
    expect(prose).toContain('<MandateProse')
  })
})

describe('the chassis', () => {
  it('is its own stacking context on the z-scale', async () => {
    const { CHASSIS_LAYER } = await import('#/components/app-sidebar')
    expect(await declared(CHASSIS_LAYER, 'isolation')).toEqual(['isolate'])
    expect(await declared(CHASSIS_LAYER, 'z-index')).toEqual([
      'var(--z-sticky)',
    ])
  })

  it('is the layer the shell’s sidebar frame wears', () => {
    expect(between(shell, '<aside', '</aside>')).toContain('CHASSIS_LAYER')
  })

  it('is never overlapped by main’s content box: main pads by its width', () => {
    // Expanded and collapsed: the frame's width and main's left padding move
    // together, so a page starts at or right of the chassis edge.
    expect(shell).toContain("narrow ? 'w-12' : 'w-58'")
    expect(shell).toContain("narrow ? 'md:pl-12' : 'md:pl-58'")
  })
})
