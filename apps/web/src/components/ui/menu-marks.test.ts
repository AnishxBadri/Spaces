import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * E12: every item of every menu leads with its 16px mark. The types ask for
 * the mark (`icon` on `DropdownMenuItem`, `DropdownMenuSubTrigger` and every
 * `MoreMenu` item but a check); this file holds what a type cannot:
 * - every item drawn in a `.tsx` under `src/` names its mark, read off the
 *   source so a new menu is covered without being listed here;
 * - nothing but `ui/dropdown-menu` reaches Radix's menus, so no item is
 *   drawn past the lead lane;
 * - the lane itself refuses an empty mark (`more-menu.test.tsx`), so an
 *   item that opens in any test without one fails it.
 */

const src = fileURLToPath(new URL('../..', import.meta.url))

function tsxFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

const files = tsxFiles(src).map((path) => ({
  path: relative(src, path),
  source: ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ),
}))

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

const where = (file: { path: string; source: ts.SourceFile }, n: ts.Node) =>
  `${file.path}:${file.source.getLineAndCharacterOfPosition(n.getStart()).line + 1}`

/** The items the menu components draw, each of which takes `icon`. */
const ITEMS = new Set(['DropdownMenuItem', 'DropdownMenuSubTrigger'])

/** Item tags in JSX that pass no `icon`. */
function unmarkedJsx(): Array<string> {
  const out: Array<string> = []
  for (const file of files) {
    walk(file.source, (n) => {
      if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return
      if (!ITEMS.has(n.tagName.getText(file.source))) return
      const marked = n.attributes.properties.some(
        (p) => ts.isJsxAttribute(p) && p.name.getText(file.source) === 'icon',
      )
      if (!marked) out.push(where(file, n))
    })
  }
  return out
}

const MENU_MODULE = /(^|\/)(ui\/)?more-menu$/

/** The keys that make an object literal a `MoreMenu` item. */
const ITEM_KEYS = ['onSelect', 'href', 'copy', 'items']

/**
 * Object literals in a file that builds `MoreMenu` entries which read as an
 * item (a `label` and something to do) with no `icon`. A check item's box
 * is its mark, so a `checked` item passes; a literal built from a spread is
 * the compiler's to read.
 */
function unmarkedMenuItems(): Array<string> {
  const out: Array<string> = []
  for (const file of files) {
    const buildsMenu = file.source.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        MENU_MODULE.test(s.moduleSpecifier.text),
    )
    if (!buildsMenu || file.path.endsWith('ui/more-menu.tsx')) continue
    walk(file.source, (n) => {
      if (!ts.isObjectLiteralExpression(n)) return
      if (n.properties.some(ts.isSpreadAssignment)) return
      const keys = n.properties.flatMap((p) =>
        p.name === undefined ? [] : [p.name.getText(file.source)],
      )
      if (!keys.includes('label') || keys.includes('checked')) return
      if (!ITEM_KEYS.some((k) => keys.includes(k))) return
      if (!keys.includes('icon')) out.push(where(file, n))
    })
  }
  return out
}

/** Files other than the primitive that import a Radix menu. */
function radixMenuImports(): Array<string> {
  const out: Array<string> = []
  for (const file of files) {
    if (file.path.endsWith('ui/dropdown-menu.tsx')) continue
    for (const s of file.source.statements) {
      if (!ts.isImportDeclaration(s)) continue
      if (!ts.isStringLiteral(s.moduleSpecifier)) continue
      const from = s.moduleSpecifier.text
      if (/^@radix-ui\/react-(dropdown-menu|context-menu|menubar)$/.test(from))
        out.push(where(file, s))
      if (from !== 'radix-ui') continue
      const named = s.importClause?.namedBindings
      if (named === undefined || !ts.isNamedImports(named)) continue
      for (const el of named.elements)
        if (
          /^(DropdownMenu|ContextMenu|Menubar)$/.test(
            el.propertyName?.text ?? el.name.text,
          )
        )
          out.push(where(file, s))
    }
  }
  return out
}

describe('every menu item leads with its mark', () => {
  it('reads the app’s menus', () => {
    // A scan that finds nothing proves nothing: the tree has dozens.
    expect(files.length).toBeGreaterThan(100)
  })

  it('gives every DropdownMenuItem and sub-menu trigger an icon', () => {
    expect(unmarkedJsx()).toEqual([])
  })

  it('gives every MoreMenu item an icon', () => {
    expect(unmarkedMenuItems()).toEqual([])
  })

  it('reaches Radix’s menus only through ui/dropdown-menu', () => {
    expect(radixMenuImports()).toEqual([])
  })
})
