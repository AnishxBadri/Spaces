import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Install, upgrade and uninstall go through one installer routine, and each
 * entry point has one caller: the program behind its server fn. Checked over
 * the source text of every shipping file in apps/ and packages/ (tests
 * excluded), so a second caller fails here naming its file.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

const INSTALLER = 'packages/core/src/writes/plugins/install.ts'
const WEB = 'apps/web/src/lib/integrations/install.ts'
const FNS = 'apps/web/src/lib/server/integrations.ts'

const sourceFiles = (dir: string): Array<string> => {
  const out: Array<string> = []
  let names: Array<string>
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.'))
      continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const files = ['apps', 'packages', 'plugins', 'scripts'].flatMap((d) =>
  sourceFiles(join(repoRoot, d)).map((full) => ({
    path: relative(repoRoot, full),
    text: readFileSync(full, 'utf8'),
  })),
)

/** One `path` per `name(` call; a `function name(` declaration is not a call. */
const callsOf = (name: string): Array<string> =>
  files.flatMap((f) =>
    (f.text.match(new RegExp(`(?<!function )\\b${name}\\(`, 'g')) ?? []).map(
      () => f.path,
    ),
  )

describe('the installer has one caller per entry point', () => {
  it('runInstaller is called by install, upgrade and uninstall and nothing else', () => {
    expect(callsOf('runInstaller')).toEqual([INSTALLER, INSTALLER, INSTALLER])
  })

  it.each([
    ['installPlugin', 'installFromRegistryProgram'],
    ['upgradePlugin', 'upgradeFromRegistryProgram'],
    ['uninstallPlugin', 'uninstallIntegrationProgram'],
  ])('%s is called once, by %s', (entry, program) => {
    expect(callsOf(entry)).toEqual([WEB])
    const web = files.find((f) => f.path === WEB)?.text ?? ''
    const body = web.slice(web.indexOf(`export const ${program} =`))
    const next = body.indexOf('\nexport ', 1)
    expect(body.slice(0, next)).toContain(`${entry}(`)
  })

  it.each([
    ['installFromRegistryProgram', 'installIntegrationHandler'],
    ['upgradeFromRegistryProgram', 'upgradeIntegrationHandler'],
    ['uninstallIntegrationProgram', 'uninstallIntegrationHandler'],
  ])(
    '%s is run only by %s, which one server fn imports',
    (program, handler) => {
      expect(callsOf(program)).toEqual([WEB])
      expect(callsOf(handler)).toEqual([FNS])
    },
  )
})
