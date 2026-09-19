import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The package's reason to exist, as a gate (mono-7). @spaces/core is the half
 * of the domain that computes: portfolio maths, the formatters, the glossary
 * automaton, the due-date grammar, the filter matcher, extraction, identity
 * normalization, the attribute registry. Nothing here may reach a database, a
 * renderer, or the environment — which is a claim that rots in a week unless
 * something checks it, so this is that something.
 *
 * Three of the four forbidden strings would be in this file if they were
 * written out, and the acceptance criterion greps the whole of
 * `packages/core/src` for them. So the needles are assembled from pieces and
 * the specifier checks parse import statements rather than matching source
 * text — the scanner has to stay outside the set it scans for.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url))
const PKG = fileURLToPath(new URL('../package.json', import.meta.url))

const DRIZZLE = `drizzle${'-'}orm`
const ENV_READ = `process${'.'}env`
const REACT = `re${'act'}`

type Source = { path: string; text: string }

const sources: Array<Source> = readdirSync(SRC, {
  recursive: true,
  encoding: 'utf8',
})
  .filter((p) => p.endsWith('.ts'))
  .map((p) => ({ path: p, text: readFileSync(SRC + p, 'utf8') }))

/**
 * Every module specifier a file imports from or re-exports from, including
 * bare side-effect imports (`import 'x'`) — a side-effect import of a db
 * module is exactly the leak this file is looking for, and it has no
 * bindings for a `from` clause to carry.
 */
function specifiers(text: string): Array<string> {
  const out: Array<string> = []
  for (const m of text.matchAll(/\bfrom\s*'([^']+)'/g)) out.push(m[1])
  for (const m of text.matchAll(/\bimport\s*\(?\s*'([^']+)'/g)) out.push(m[1])
  return out
}

const owns = (spec: string, pkg: string) =>
  spec === pkg || spec.startsWith(`${pkg}/`)

describe('@spaces/core is pure', () => {
  it('scans the whole package', () => {
    // A scanner that silently found nothing would pass every case below.
    expect(sources.length).toBeGreaterThan(15)
  })

  it('imports no database driver', () => {
    const offenders = sources.filter((s) =>
      specifiers(s.text).some(
        (spec) =>
          owns(spec, DRIZZLE) ||
          owns(spec, 'pg') ||
          owns(spec, 'postgres') ||
          spec.startsWith('@spaces/db/index'),
      ),
    )
    expect(offenders.map((s) => s.path)).toEqual([])
  })

  it('imports no renderer', () => {
    const offenders = sources.filter((s) =>
      specifiers(s.text).some(
        (spec) =>
          owns(spec, REACT) ||
          owns(spec, `${REACT}-dom`) ||
          spec.startsWith('@tanstack/'),
      ),
    )
    expect(offenders.map((s) => s.path)).toEqual([])
  })

  it('reads no environment', () => {
    const offenders = sources.filter((s) => s.text.includes(ENV_READ))
    expect(offenders.map((s) => s.path)).toEqual([])
  })

  /**
   * Spec §2 lets core depend on db, and the column payload types
   * (`AttributeOptions`, `SelectOption`, `ObjectKind`, `BadgeColor`, the view
   * condition shapes) are declared at their columns and re-exported from here
   * — so the reach is real but has to stay a type. `verbatimModuleSyntax`
   * erases `import type` outright: no value, no table object, no `db`, and
   * nothing of @spaces/db in the bundle.
   */
  it('reaches @spaces/db for types only', () => {
    const offenders: Array<string> = []
    for (const s of sources) {
      // Whitespace collapsed so a multi-line specifier list reads as one
      // statement; the owning keyword is then the nearest `import `/`export `
      // to the left of the specifier, which is what decides whether the
      // binding survives compilation.
      const flat = s.text.replace(/\s+/g, ' ')
      for (const m of flat.matchAll(/from '(@spaces\/db[^']*)'/g)) {
        const before = flat.slice(0, m.index)
        const kw = Math.max(
          before.lastIndexOf('import '),
          before.lastIndexOf('export '),
        )
        const clause = kw === -1 ? '' : before.slice(kw)
        if (!/^(?:import|export) type\b/.test(clause)) {
          offenders.push(`${s.path}: ${clause.trim()}from '${m[1]}'`)
        }
      }
      for (const m of flat.matchAll(/\bimport\s*'(@spaces\/db[^']*)'/g)) {
        offenders.push(`${s.path}: side-effect import of '${m[1]}'`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('declares no dependency on either', () => {
    const pkg = readFileSync(PKG, 'utf8')
    const manifest: unknown = JSON.parse(pkg)
    const named = new Set<string>()
    if (manifest && typeof manifest === 'object') {
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const block: unknown = Reflect.get(manifest, field)
        if (block && typeof block === 'object') {
          for (const name of Object.keys(block)) named.add(name)
        }
      }
    }
    expect(named.has(DRIZZLE)).toBe(false)
    expect(named.has(REACT)).toBe(false)
    expect(named.has(`${REACT}-dom`)).toBe(false)
  })
})
