import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The external API has one door (SPA-37, D8). `effect/unstable/httpapi` is
 * imported by exactly one file, `api.ts`, so the definition, its handlers,
 * the typed client and the OpenAPI document cannot drift into two. And no
 * route or component names `effect` at all, statically or by dynamic import:
 * the `/api/v1/$` route reaches the door through `#/lib/rpc/api`, never
 * through Effect. eslint says the second half too; this says the first,
 * which no import rule can — "only this file" is a fact about the whole tree.
 *
 * Text only, like `job-run-one-writer.test.ts`: no imports of the code under
 * guard, and a failure names the file.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

const THE_DOOR = 'apps/web/src/lib/rpc/api.ts'

/** The scanner quotes the specifier; it is not an importer of it. */
const SELF = relative(repoRoot, fileURLToPath(import.meta.url))

/** Static `from '…'`, side-effect `import '…'` and `import('…')`. */
const importsOf = (text: string, specifier: RegExp): boolean =>
  new RegExp(
    String.raw`(?:from|import)\s*\(?\s*['"]` + specifier.source + `['"]`,
  ).test(text)

const HTTPAPI = /effect\/unstable\/httpapi/
const ANY_EFFECT = /effect(?:\/[^'"]*)?/

function sourceFiles(dir: string): Array<string> {
  const out: Array<string> = []
  let entries: Array<string>
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function scanRoots(): Array<string> {
  const roots = [join(repoRoot, 'apps/web/src')]
  for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
    roots.push(join(repoRoot, 'packages', pkg, 'src'))
  }
  return roots
}

describe('the HttpApi door', () => {
  it('is the only file that imports effect/unstable/httpapi', () => {
    const importers: Array<string> = []
    for (const root of scanRoots()) {
      for (const file of sourceFiles(root)) {
        const path = relative(repoRoot, file)
        if (path === SELF) continue
        if (importsOf(readFileSync(file, 'utf8'), HTTPAPI)) importers.push(path)
      }
    }
    expect(
      importers,
      `effect/unstable/httpapi is imported outside ${THE_DOOR}. Add the procedure there; everything else reaches the API through its exports`,
    ).toEqual([THE_DOOR])
  })

  it('keeps effect out of routes and components entirely', () => {
    const offenders: Array<string> = []
    for (const dir of ['apps/web/src/routes', 'apps/web/src/components']) {
      for (const file of sourceFiles(join(repoRoot, dir))) {
        if (importsOf(readFileSync(file, 'utf8'), ANY_EFFECT)) {
          offenders.push(relative(repoRoot, file))
        }
      }
    }
    expect(
      offenders,
      'Effect never crosses into React — the seam is effectFn() / HttpApi handlers',
    ).toEqual([])
  })

  it('matches the spellings it guards, so a regex slip cannot disarm it', () => {
    expect(
      importsOf(`import { A } from 'effect/unstable/httpapi'`, HTTPAPI),
    ).toBe(true)
    expect(importsOf(`await import("effect/unstable/httpapi")`, HTTPAPI)).toBe(
      true,
    )
    expect(importsOf(`import { Effect } from 'effect'`, ANY_EFFECT)).toBe(true)
    expect(
      importsOf(`import { X } from 'effect/unstable/http'`, ANY_EFFECT),
    ).toBe(true)
    expect(importsOf(`import { X } from 'effectful'`, ANY_EFFECT)).toBe(false)
    expect(importsOf(`import { X } from '#/lib/rpc/api'`, ANY_EFFECT)).toBe(
      false,
    )
  })
})
