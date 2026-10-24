import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The fence between core's two halves.
 * - Outside `writes/` is pure: it computes and never reaches a database
 *   (types from `@spaces/db` only).
 * - `writes/` is the db-coupled half and the only place drizzle or `db` passes.
 * - Neither half reaches a renderer; only ENV_READING_DIRS read the environment.
 * - The needles are assembled from pieces and imports are parsed, not
 *   grepped, so this file never matches a grep for the strings it bans.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url))
const PKG = fileURLToPath(new URL('../package.json', import.meta.url))

const DRIZZLE = `drizzle${'-'}orm`
const ENV_READ = `process${'.'}env`
const REACT = `re${'act'}`
const DB_PKG = `@spaces/${'db'}`

/**
 * The directories, relative to `src/`, where a database import is allowed.
 * Everything else is pure. Add a directory only when a db-coupled module
 * lands in it: a name here is a directory the driver ban no longer watches.
 */
const DB_COUPLED_DIRS: ReadonlyArray<string> = ['writes/']

/**
 * Where an environment read is allowed, relative to `src/`: the vault
 * (MASTER_KEY, DATA_DIR), the blob backend (STORAGE_DRIVER, S3_*) and the
 * first-boot conveniences (SPACES_PLUGINS, SPACES_CREDENTIAL_<ID>).
 * Narrower than DB_COUPLED_DIRS on purpose: other write paths take a
 * transaction or connection string and read no env.
 */
const ENV_READING_DIRS: ReadonlyArray<string> = [
  'writes/vault/',
  'writes/storage/',
  'writes/plugins/first-boot.ts',
]

type Source = { path: string; text: string }

const sources: Array<Source> = readdirSync(SRC, {
  recursive: true,
  encoding: 'utf8',
})
  .filter((p) => p.endsWith('.ts'))
  .map((p) => ({ path: p, text: readFileSync(SRC + p, 'utf8') }))

const isDbCoupled = (path: string) =>
  DB_COUPLED_DIRS.some((dir) => path.startsWith(dir))

const pure = sources.filter((s) => !isDbCoupled(s.path))
const dbCoupled = sources.filter((s) => isDbCoupled(s.path))

const mayReadEnv = (path: string) =>
  ENV_READING_DIRS.some((dir) => path.startsWith(dir))
const readsEnv = (s: Source) => s.text.includes(ENV_READ)

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

const importsDriver = (s: Source) =>
  specifiers(s.text).some(
    (spec) =>
      owns(spec, DRIZZLE) ||
      owns(spec, 'pg') ||
      owns(spec, 'postgres') ||
      spec.startsWith('@spaces/db/index'),
  )

/** The files among `set` that import a database driver, by path. */
function driverOffenders(set: ReadonlyArray<Source>): Array<string> {
  return set.filter(importsDriver).map((s) => s.path)
}

/**
 * Core may depend on db, and the column payload types
 * (`AttributeOptions`, `SelectOption`, `ObjectKind`, `BadgeColor`, the view
 * condition shapes) are declared at their columns and re-exported from here
 * — so in a pure directory the reach is real but has to stay a type.
 * `verbatimModuleSyntax` erases `import type` outright: no value, no table
 * object, no `db`, and nothing of @spaces/db in the bundle.
 */
function dbValueOffenders(set: ReadonlyArray<Source>): Array<string> {
  const offenders: Array<string> = []
  for (const s of set) {
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
  return offenders
}

describe('@spaces/core is pure outside src/writes/', () => {
  it('scans the whole package', () => {
    // A scanner that silently found nothing would pass every case below.
    expect(sources.length).toBeGreaterThan(15)
    expect(pure.length).toBeGreaterThan(15)
  })

  it('a pure directory imports no database driver', () => {
    expect(driverOffenders(pure)).toEqual([])
  })

  it('a pure directory reaches @spaces/db for types only', () => {
    expect(dbValueOffenders(pure)).toEqual([])
  })

  it('imports no renderer, in either half', () => {
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

  it('reads no environment outside the vault, the blob backend and first boot', () => {
    const offenders = sources.filter((s) => !mayReadEnv(s.path) && readsEnv(s))
    expect(offenders.map((s) => s.path)).toEqual([])
  })

  /**
   * Same earning-its-keep rule as the driver allowlist: a directory named as
   * env-reading has to hold a module that reads it, or the exemption is a
   * hole with nothing behind it.
   */
  it('every env-reading directory holds a module that reads the environment', () => {
    for (const dir of ENV_READING_DIRS) {
      const here = sources.filter((s) => s.path.startsWith(dir))
      expect(here.filter(readsEnv).length, dir).toBeGreaterThan(0)
    }
    // …and it is a subset of the db-coupled half, never a third half.
    for (const dir of ENV_READING_DIRS) expect(isDbCoupled(dir)).toBe(true)
  })

  /**
   * The allowlist has to be earning its keep: a db-coupled directory that
   * holds no db-coupled module is a hole in the fence with nothing behind
   * it, so every name in DB_COUPLED_DIRS must hold at least one file that
   * imports the driver.
   */
  it('every db-coupled directory holds a module that uses the driver', () => {
    for (const dir of DB_COUPLED_DIRS) {
      const here = dbCoupled.filter((s) => s.path.startsWith(dir))
      expect(driverOffenders(here).length, dir).toBeGreaterThan(0)
    }
  })

  /**
   * The fence still bites where it should. Narrowing the ban to directories
   * would be silent if the scanner had quietly stopped matching, so the
   * checks are run over a synthetic pure-directory module that commits both
   * sins, and over the same module placed under `writes/`, where neither is
   * one.
   */
  it('still fails a driver import and a db value import in a pure directory', () => {
    // The db specifier is assembled too: this file is in the set it scans.
    const text = `import { eq } from '${DRIZZLE}'\nimport { db } from '${DB_PKG}'\n`
    const inPure: Source = { path: 'portfolio/scratch.ts', text }
    const inWrites: Source = { path: 'writes/attributes/scratch.ts', text }

    expect(driverOffenders([inPure])).toEqual(['portfolio/scratch.ts'])
    const valueImports = dbValueOffenders([inPure])
    expect(valueImports).toHaveLength(1)
    expect(valueImports[0]).toMatch(/^portfolio\/scratch\.ts: import \{ db \}/)
    expect(isDbCoupled(inPure.path)).toBe(false)

    expect(isDbCoupled(inWrites.path)).toBe(true)
    // …and the pure-half checks would never see it: they run over `pure`.
    expect(pure.some((s) => isDbCoupled(s.path))).toBe(false)

    // The env read, likewise: named in a write path, caught; in the vault, not.
    const env: Source = {
      path: 'writes/attributes/scratch.ts',
      text: `const x = ${ENV_READ}.DATABASE_URL\n`,
    }
    expect(readsEnv(env) && !mayReadEnv(env.path)).toBe(true)
    expect(mayReadEnv('writes/vault/scratch.ts')).toBe(true)
  })

  it('declares no dependency on a renderer', () => {
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
    // drizzle-orm is a declared dependency (`writes/` imports it), so the
    // manifest check is the renderer only; the driver ban is the scan above.
    expect(named.has(REACT)).toBe(false)
    expect(named.has(`${REACT}-dom`)).toBe(false)
    expect(named.has('@tanstack/react-start')).toBe(false)
  })
})
