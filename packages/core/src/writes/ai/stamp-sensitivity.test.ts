import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `chunk.sensitive` has one writing module (`stampSensitivity`'s) across the
 * whole workspace — seeds included, tests excluded, since a test may insert a
 * stamped fixture row — and every write of a binding or the workspace default
 * names its raise. Raise and lowering behaviour is tested in apps/web.
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

  it('every write of the binding and workspace inputs raises in its transaction', () => {
    const inputs = [
      // A binding born with a sensitivity.
      { write: /\.insert\(\s*storageBinding\s*\)/, raise: "kind: 'binding'" },
      // The workspace floor.
      {
        write: /jsonb_build_object\('sensitivity_default'/,
        raise: "kind: 'workspace'",
      },
    ]
    for (const input of inputs) {
      const writers = sources.filter((s) => input.write.test(s.text))
      expect(writers.length, String(input.write)).toBeGreaterThan(0)
      for (const s of writers) expect(s.text, s.path).toContain(input.raise)
    }
  })

  it('the one chunk insert leaves the column at its default for the stamp to correct', () => {
    const inserters = sources.filter((s) => DRIZZLE_INSERT.test(s.text))
    expect(inserters.map((s) => s.path)).toEqual([
      'apps/web/src/lib/ai/embed-chunks.ts',
    ])
    for (const s of inserters) expect(s.text).not.toMatch(/\bsensitive\s*:/)
  })
})
