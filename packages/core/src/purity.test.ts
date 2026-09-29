import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The package's reason to exist, as a gate (mono-7), per directory since
 * SPA-174. @spaces/core is the domain in two halves. The pure half computes:
 * portfolio maths, the formatters, the glossary automaton, the due-date
 * grammar, the filter matcher, extraction, identity normalization, the
 * attribute registry — nothing there may reach a database. The db-coupled
 * half is `src/writes/` and nothing else: the attribute write path the plugin
 * SDK's Facts port will sit on, which needs drizzle and the `db` handle by
 * definition. Neither half may reach a renderer, and one directory in the
 * db-coupled half — `writes/vault/`, which resolves MASTER_KEY and DATA_DIR
 * (SPA-176) — is the only one that may read the environment. All of that is
 * a claim that rots in a week unless something checks it, so this is that
 * something.
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
const DB_PKG = `@spaces/${'db'}`

/**
 * The directories, relative to `src/`, where a database import is allowed.
 * Everything else is pure. A directory joins this list when a db-coupled
 * module moves into core (SPA-174 brought `writes/`; the vault, storage and
 * the assembler each add theirs when they land) — and only then, because a
 * name here is a directory the driver ban no longer watches.
 */
const DB_COUPLED_DIRS: ReadonlyArray<string> = ['writes/']

/**
 * The directories, relative to `src/`, where an environment read is allowed
 * — the vault, whose whole job is to resolve MASTER_KEY and DATA_DIR (SPA-176).
 * Narrower than DB_COUPLED_DIRS on purpose: the write paths beside it take a
 * transaction or a connection string and read nothing; an enqueue that would
 * have needed DATABASE_URL stayed in apps/web for exactly this reason.
 */
const ENV_READING_DIRS: ReadonlyArray<string> = ['writes/vault/']

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
 * Spec §2 lets core depend on db, and the column payload types
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

  it('reads no environment outside the vault', () => {
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
    // drizzle-orm is declared since SPA-174 — it is what `writes/` imports —
    // so the manifest check is the renderer only; the driver ban is the
    // per-directory scan above.
    expect(named.has(REACT)).toBe(false)
    expect(named.has(`${REACT}-dom`)).toBe(false)
    expect(named.has('@tanstack/react-start')).toBe(false)
  })
})
