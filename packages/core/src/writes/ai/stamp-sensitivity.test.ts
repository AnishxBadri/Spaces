import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `chunk.sensitive` has one writing module, `stamp-sensitivity.ts`, across
 * the whole workspace — apps, packages and plugins, seeds included, tests
 * excluded (a test may insert a stamped fixture row). The behaviour of the
 * raise and the lowering job is asserted beside the write paths that call
 * them, in apps/web's `restamp.test.ts`.
 */

const root = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../..',
)

function productionSources(): Array<{ path: string; text: string }> {
  const trees = ['apps', 'packages', 'plugins', 'plugins/_fixtures'].flatMap(
    (parent) =>
      readdirSync(join(root, parent), { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '_fixtures')
        .map((d) => `${parent}/${d.name}/src`)
        .filter((tree) => existsSync(join(root, tree))),
  )
  return trees
    .flatMap((tree) =>
      readdirSync(join(root, tree), { recursive: true, encoding: 'utf8' })
        .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
        .map((f) => `${tree}/${f}`),
    )
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }))
}

/** A drizzle update of `chunk` whose `.set(…)` names `sensitive`, or hides it in a variable. */
const DRIZZLE_UPDATE =
  /\.update\(\s*chunk\s*\)\s*\.set\(\s*(?:\{[^}]*\bsensitive\b|[A-Za-z_$])/
/** Raw SQL that sets or inserts the column. */
const RAW_SQL =
  /(?:update\s+"?chunk"?\s+set|insert\s+into\s+"?chunk"?)[^;`]{0,400}?\bsensitive\b/i
const DRIZZLE_INSERT = /\.insert\(\s*chunk\s*\)/

describe('one writer of chunk.sensitive', () => {
  const sources = productionSources()

  it('only stamp-sensitivity.ts updates the column', () => {
    const writers = sources
      .filter((s) => DRIZZLE_UPDATE.test(s.text) || RAW_SQL.test(s.text))
      .map((s) => s.path)
      .sort()
    expect(writers).toEqual([
      'packages/core/src/writes/ai/stamp-sensitivity.ts',
    ])
  })

  it('the one chunk insert leaves the column at its default for the stamp to correct', () => {
    const inserters = sources.filter((s) => DRIZZLE_INSERT.test(s.text))
    expect(inserters.map((s) => s.path)).toEqual([
      'apps/web/src/lib/ai/embed-chunks.ts',
    ])
    for (const s of inserters) expect(s.text).not.toMatch(/\bsensitive\s*:/)
  })
})
