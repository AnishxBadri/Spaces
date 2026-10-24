import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A mention in a note body is a chip, not a browser link.
 * - `@blocknote/shadcn/style.css` reverts every anchor in the editor to the
 *   user agent's blue underline at 0-2-1, which `.mention-chip` (0-1-0) loses to.
 * - No DOM here: for every vendor rule setting `color` or `text-decoration`
 *   on an anchor, the app sheet must hold an `a.mention-chip` rule that sets
 *   it and outranks it on specificity — sheet order is not controlled.
 */

type Rule = { selectors: Array<string>; decls: Map<string, string> }

/** Leaf rules of a stylesheet, at any depth (@media, @layer, @supports). */
function leafRules(css: string): Array<Rule> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Array<Rule> = []
  const stack: Array<{ prelude: string; nested: boolean }> = []
  let buf = ''
  for (const ch of src) {
    if (ch === '{') {
      if (stack.length > 0) stack[stack.length - 1].nested = true
      stack.push({ prelude: buf.trim(), nested: false })
      buf = ''
    } else if (ch === '}') {
      const top = stack.pop()
      if (top && !top.nested && !top.prelude.startsWith('@')) {
        const decls = new Map<string, string>()
        for (const d of buf.split(';')) {
          const i = d.indexOf(':')
          if (i > 0)
            decls.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim())
        }
        rules.push({
          selectors: top.prelude.split(',').map((s) => s.trim()),
          decls,
        })
      }
      buf = ''
    } else {
      buf += ch
    }
  }
  return rules
}

/** [ids, classes/attributes/pseudo-classes, types] — enough for these sheets. */
function specificity(selector: string): [number, number, number] {
  const s = selector
    .replace(/:where\([^)]*\)/g, '')
    .replace(/::[\w-]+/g, ' ')
    .replace(/\[[^\]]*\]/g, '.x')
  const ids = (s.match(/#[\w-]+/g) ?? []).length
  const classes =
    (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/:[\w-]+/g) ?? []).length
  const types = s
    .split(/[\s>+~]+/)
    .filter((part) => /^[a-z]/i.test(part)).length
  return [ids, classes, types]
}

function outranks(a: [number, number, number], b: [number, number, number]) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** The last compound of a selector — what the rule actually lands on. */
function subject(selector: string): string {
  return (
    selector
      .split(/[\s>+~]+/)
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

const require = createRequire(import.meta.url)
const vendor = leafRules(
  readFileSync(require.resolve('@blocknote/shadcn/style.css'), 'utf8'),
)
const app = leafRules(
  readFileSync(
    fileURLToPath(new URL('../../styles.css', import.meta.url)),
    'utf8',
  ),
)

const LINK_PROPS = ['color', 'text-decoration'] as const

describe('the mention chip inside the editor', () => {
  // Every vendor rule whose subject is a bare anchor and that restyles link ink.
  const offenders = vendor.flatMap((r) =>
    r.selectors
      .filter((sel) => /^a(?![\w-])/.test(subject(sel)))
      .flatMap((sel) =>
        LINK_PROPS.filter((p) => r.decls.has(p)).map((prop) => ({ sel, prop })),
      ),
  )

  // Every app rule that lands on an anchor chip.
  const chipRules = app.flatMap((r) =>
    r.selectors
      .filter((sel) => /^a\.mention-chip(?![\w-])/.test(subject(sel)))
      .map((sel) => ({ sel, decls: r.decls })),
  )

  it.each(offenders)('outranks `$sel` on $prop', ({ sel, prop }) => {
    const winner = chipRules.find(
      (c) =>
        c.decls.has(prop) && outranks(specificity(c.sel), specificity(sel)),
    )
    expect(
      winner,
      `no a.mention-chip rule in styles.css sets ${prop} above ${sel}`,
    ).toBeDefined()
  })

  it('draws the chip in ink with no underline', () => {
    const decls = new Map(chipRules.flatMap((c) => [...c.decls]))
    expect(decls.get('color')).toBe('var(--foreground)')
    expect(decls.get('text-decoration')).toBe('none')
  })
})
