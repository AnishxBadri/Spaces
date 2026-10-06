import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `contact_at` is retired: a person's companies are the `companies`
 * attribute, written through the one write path. (D60) The enum value stays,
 * so the database would still take one — this is what keeps any code path,
 * seeds included, from writing it.
 * - Reads every non-test module of every workspace package and plugin.
 * - Turbo hashes the worker and plugin sources into this package's test
 *   task (`@spaces/web#test` inputs), so a write added there re-runs it.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

const ROOTS = ['apps/web/src', 'apps/worker/src', 'packages', 'plugins']

const walk = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = join(dir, e.name)
    if (e.isDirectory())
      return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(file)
    return /\.(ts|tsx|js|mjs)$/.test(e.name) &&
      !/\.test\.(ts|tsx)$/.test(e.name)
      ? [file]
      : []
  })

/** A `contact_at` write, however it is spelt: a drizzle value or raw SQL. */
const WRITES: ReadonlyArray<RegExp> = [
  /\brelation\s*:\s*['"`]contact_at['"`]/,
  /insert\s+into\s+"?link"?[^;]*contact_at/i,
  /\.set\(\s*\{[^}]*relation\s*:\s*['"`]contact_at/,
]

const writesContactAt = (text: string): boolean =>
  WRITES.some((re) => re.test(text))

describe('nothing writes link(contact_at)', () => {
  it('recognises the shapes it is looking for', () => {
    expect(
      writesContactAt(`.values({ fromEntityId: a, relation: 'contact_at' })`),
    ).toBe(true)
    expect(
      writesContactAt(
        `INSERT INTO link (from_entity_id, relation) VALUES ($1, 'contact_at')`,
      ),
    ).toBe(true)
    expect(writesContactAt(`relation: 'references', attrSlug: 'x'`)).toBe(false)
  })

  it('has no writer in any package, plugin or seed', () => {
    const sources = ROOTS.map((r) => join(repoRoot, r))
      .filter((dir) => existsSync(dir))
      .flatMap(walk)
    // The seeds are where the last two writers lived.
    expect(sources.some((f) => f.endsWith('lib/seeds/dev.ts'))).toBe(true)
    expect(sources.some((f) => f.endsWith('lib/seeds/demo.ts'))).toBe(true)

    const writers = sources
      .filter((f) => writesContactAt(readFileSync(f, 'utf8')))
      .map((f) => relative(repoRoot, f))
    expect(writers).toEqual([])
  })
})
