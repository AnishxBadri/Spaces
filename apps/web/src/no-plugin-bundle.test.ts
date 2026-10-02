import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Web never loads a plugin bundle or reads the plugins directory: it renders
 * from `integration.manifest` alone, so web and worker can live in separate
 * containers. (D63)
 * - The source half reads every module under `src`.
 * - The build half reads `.output` when a build has left one, and passes
 *   vacuously when none has run.
 */

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const self = fileURLToPath(import.meta.url)

const walk = (dir: string, keep: (file: string) => boolean): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = join(dir, e.name)
    if (e.isDirectory())
      return e.name === 'node_modules' ? [] : walk(file, keep)
    return keep(file) ? [file] : []
  })

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

/**
 * A specifier that reaches plugin code or the worker that hosts it. Core's
 * own `plugins/` modules (lock, verify, credit) are the host's, not a plugin's.
 */
const isPluginSpecifier = (spec: string): boolean =>
  spec.startsWith('@spaces/plugin-') ||
  (/(^|\/)plugins\//.test(spec) && !spec.startsWith('@spaces/core/plugins/')) ||
  spec.includes('apps/worker') ||
  spec.startsWith('@spaces/worker')

/** A read of the plugins directory, however it is spelt. */
const PLUGINS_DIR_READS: ReadonlyArray<RegExp> = [
  /\bpluginsRootDir\b/,
  /dataDir\(\)[^;\n]*['"`]\/?plugins\b/,
  /['"`][^'"`]*\/data\/plugins\b/,
]

/** Strings only plugin code carries: the packages' names, Effect span names. */
const PLUGIN_MARKERS: ReadonlyArray<string> = [
  '@spaces/plugin-',
  'pluginsRootDir',
  'plugins/_fixtures/',
  'plugins/apollo/',
  'apollo.readRecord',
  'provider.example/v1/organizations/enrich',
]

describe('web never loads a plugin bundle', () => {
  const sources = walk(
    join(webRoot, 'src'),
    (f) => /\.(ts|tsx)$/.test(f) && f !== self,
  )

  it('no module under src imports plugins/* or the worker', () => {
    const offenders = sources.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(SPECIFIER)]
        .map((m) => m[1])
        .filter(isPluginSpecifier)
        .map((spec) => `${relative(webRoot, file)}: ${spec}`),
    )
    expect(offenders).toEqual([])
  })

  it('no module under src reads the plugins directory', () => {
    const offenders = sources.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return PLUGINS_DIR_READS.filter((re) => re.test(text)).map(
        (re) => `${relative(webRoot, file)}: ${String(re)}`,
      )
    })
    expect(offenders).toEqual([])
  })

  it('the built output carries no plugin code and no plugins-directory read', () => {
    const output = join(webRoot, '.output')
    if (!existsSync(output)) return
    const offenders = walk(output, (f) => /\.(m?js|map)$/.test(f)).flatMap(
      (file) => {
        const text = readFileSync(file, 'utf8')
        return PLUGIN_MARKERS.filter((m) => text.includes(m)).map(
          (m) => `${relative(webRoot, file)}: ${m}`,
        )
      },
    )
    expect(offenders).toEqual([])
  })

  it('the patterns catch what they are for', () => {
    expect(isPluginSpecifier('@spaces/plugin-apollo')).toBe(true)
    expect(isPluginSpecifier('../../../../plugins/apollo/src/index')).toBe(true)
    expect(isPluginSpecifier('#/lib/server/plugins')).toBe(false)
    expect(isPluginSpecifier('./server/plugins')).toBe(false)
    expect(
      PLUGINS_DIR_READS.some((re) =>
        re.test("path.join(dataDir(), 'plugins', id)"),
      ),
    ).toBe(true)
    expect([
      ...`import x from '@spaces/plugin-echo'`.matchAll(SPECIFIER),
    ]).toHaveLength(1)
  })
})
