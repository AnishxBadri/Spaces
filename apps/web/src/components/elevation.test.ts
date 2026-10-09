import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  BAYER,
  SHADOW_LEVEL,
  SHADOW_OFFSET,
  cellsFor,
  ditherShadowUrl,
} from './dither.tsx'
import { selectClasses } from './ui/select.tsx'

/**
 * Elevation by kind: a popover, menu or picker (no scrim) lifts on the
 * dithered shadow; a window over the scrim keeps the solid one. The
 * primitives choose, and nothing else in the app spells a shadow.
 */

const src = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(join(src, 'styles.css'), 'utf8')
const read = (path: string) => readFileSync(join(src, path), 'utf8')

/** The body of one `@utility name { … }` block (no nested braces). */
function utility(name: string): string {
  const match = new RegExp(`@utility ${name} \\{([^}]*)\\}`).exec(css)
  expect(match, name).not.toBeNull()
  return match?.[1] ?? ''
}

function tsxFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

const ink = /--hairline:\s*(#[0-9a-f]{6});/.exec(css)?.[1] ?? ''

describe('shadow-dither', () => {
  const body = utility('shadow-dither')

  it('is the dither generator’s output, verbatim, in the ink token', () => {
    expect(ink).toBe('#1c1c1a')
    expect(body).toContain(ditherShadowUrl(ink))
  })

  it('draws the Bayer table at 8 of 16, cell for cell', () => {
    const svg = decodeURIComponent(
      /data:image\/svg\+xml,([^"]*)"/.exec(body)?.[1] ?? '',
    )
    const drawn = [
      ...svg.matchAll(/<rect x='(\d+)' y='(\d+)' width='2' height='2'\/>/g),
    ].map((m) => [Number(m[1]), Number(m[2])])
    const fromTable = BAYER.flatMap((row, y) =>
      row.flatMap((t, x) => (t < SHADOW_LEVEL ? [[x * 2, y * 2]] : [])),
    )
    expect(SHADOW_LEVEL).toBe(8)
    expect(drawn).toEqual(fromTable)
    expect(drawn).toEqual(cellsFor(8))
    expect(drawn).toHaveLength(8)
  })

  it('sits outside the 1px ink edge and never paints under the paper', () => {
    expect(SHADOW_OFFSET).toBe(4)
    // Slices 1px top and left (the edge), 5px right and bottom (edge + 4px
    // outset); no `fill`, so the middle — the sheet's paper — is untouched.
    const tail = body.slice(body.lastIndexOf('")') + 2).trim()
    expect(tail).toBe('1 5 5 1 / 1px 5px 5px 1px / 0 4px 4px 0 stretch;')
    expect(body).toContain('border: 1px solid var(--hairline);')
  })

  it('never animates', () => {
    expect(body).not.toMatch(/transition|animation/)
    expect(utility('shadow-solid')).not.toMatch(/transition|animation/)
  })
})

describe('the primitives', () => {
  const popoverKind: Array<[string, string, number]> = [
    ['Popover', 'components/ui/popover.tsx', 1],
    // DropdownMenuContent and DropdownMenuSubContent.
    ['DropdownMenu', 'components/ui/dropdown-menu.tsx', 2],
    ['Select', 'components/ui/select.tsx', 1],
  ]
  const windowKind: Array<[string, string, number]> = [
    ['DialogContent', 'components/ui/dialog.tsx', 1],
  ]

  it.each(popoverKind)('%s lifts on the dither', (_, path, n) => {
    const source = read(path)
    expect(source.match(/\bshadow-dither\b/g)).toHaveLength(n)
    expect(source).not.toMatch(/\bshadow-solid\b/)
  })

  it.each(windowKind)('%s keeps the solid shadow', (_, path, n) => {
    const source = read(path)
    expect(source.match(/\bshadow-solid\b/g)).toHaveLength(n)
    expect(source).not.toMatch(/\bshadow-dither\b/)
  })

  it('the Select sheet carries the dither', () => {
    expect(selectClasses({ width: 'trigger' }).sheet.split(' ')).toContain(
      'shadow-dither',
    )
  })

  it('the confirm and the palette are windows: DialogContent, no shadow of their own', () => {
    for (const path of [
      'components/ui/confirm-dialog.tsx',
      'components/ui/command.tsx',
    ]) {
      const source = read(path)
      expect(source, path).toContain('<DialogContent')
      expect(source, path).not.toMatch(/\bshadow-/)
    }
  })

  it('the BlockNote sheets take the dither, and no box-shadow is left there', () => {
    const editor = css.slice(css.indexOf('.prose-note .bn-root {'))
    for (const selector of ['.prose-note .bn-panel {', '.bn-select {']) {
      const at = editor.indexOf(selector)
      expect(at, selector).toBeGreaterThan(-1)
      const block = editor.slice(at, editor.indexOf('}', at))
      expect(block, selector).toContain('@apply shadow-dither;')
      expect(block, selector).not.toContain('box-shadow')
    }
    expect(editor).not.toMatch(/box-shadow:\s*\d/)
  })

  it('no tsx in the app spells an arbitrary shadow', () => {
    const spelling = tsxFiles(src)
      .filter((f) => /shadow-[[(]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f))
    expect(spelling).toEqual([])
  })
})
