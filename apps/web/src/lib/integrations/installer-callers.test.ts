import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Install, upgrade and uninstall go through one installer routine. Install
 * has exactly three callers — the registry install and the upload, each
 * behind its server fn, and first boot's SPACES_PLUGINS; upgrade and
 * uninstall one each, the program behind its server fn. Checked over
 * the source text of every shipping file in apps/ and packages/ (tests
 * excluded), so a second caller fails here naming its file.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

const INSTALLER = 'packages/core/src/writes/plugins/install.ts'
const WEB = 'apps/web/src/lib/integrations/install.ts'
const FNS = 'apps/web/src/lib/server/integrations.ts'
const FIRST_BOOT = 'packages/core/src/writes/plugins/first-boot.ts'

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

/** The text of one exported program, up to the next export. */
const programBody = (path: string, program: string): string => {
  const text = files.find((f) => f.path === path)?.text ?? ''
  const start = text.indexOf(`export const ${program} =`)
  if (start === -1) return ''
  const body = text.slice(start)
  const next = body.indexOf('\nexport ', 1)
  return next === -1 ? body : body.slice(0, next)
}

describe('the installer has one caller per entry point', () => {
  it('runInstaller is called by install, upgrade and uninstall and nothing else', () => {
    expect(callsOf('runInstaller')).toEqual([INSTALLER, INSTALLER, INSTALLER])
  })

  /** Two doors in web — the registry and an upload — and one at boot, all one function. */
  it('installPlugin is called by the registry install, the upload and first boot, and nothing else', () => {
    expect(callsOf('installPlugin').sort()).toEqual([WEB, WEB, FIRST_BOOT])
    for (const program of [
      'installFromRegistryProgram',
      'installFromUploadProgram',
    ])
      expect(programBody(WEB, program), program).toContain('installPlugin(')
    expect(
      files.find((f) => f.path === FIRST_BOOT)?.text.match(/installPlugin\(/g),
    ).toHaveLength(1)
  })

  it.each([
    ['upgradePlugin', 'upgradeFromRegistryProgram'],
    ['uninstallPlugin', 'uninstallIntegrationProgram'],
  ])('%s is called once, by %s', (entry, program) => {
    expect(callsOf(entry)).toEqual([WEB])
    expect(programBody(WEB, program)).toContain(`${entry}(`)
  })

  it.each([
    ['installFromRegistryProgram', 'installIntegrationHandler'],
    ['installFromUploadProgram', 'uploadIntegrationHandler'],
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
