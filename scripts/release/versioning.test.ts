import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NewChangeset, VersionType } from '@changesets/types'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  CORE_PACKAGE,
  ROOT,
  SDK_PACKAGE,
  loadConfig,
  manifestVersionOf,
  parsePluginTag,
  readPackageJson,
  releasePlanFor,
  spelledVersionDrift,
  tagCandidates,
  tagFor,
  tagsToCreate,
  versionPackages,
  versionedPackages,
  withManifestVersion,
  workspacePackages,
} from './versioning.ts'
import type { TagCandidate } from './versioning.ts'

const changeset = (
  id: string,
  releases: Record<string, Exclude<VersionType, 'none'>>,
): NewChangeset => ({
  id,
  summary: id,
  releases: Object.entries(releases).map(([name, type]) => ({ name, type })),
})

/** The pattern release.yml's `version` job accepts, copied verbatim. */
const RELEASE_YML_TAG = /^core@([0-9]+)\.([0-9]+)\.([0-9]+)$/

const realPlugins = readdirSync(path.join(ROOT, 'plugins'), {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => d.name)
  .sort()

describe('tag names', () => {
  it('maps each version line to the tag its workflow fires on', () => {
    expect(tagFor(CORE_PACKAGE, '1.2.3')).toBe('core@1.2.3')
    expect(tagFor('@spaces/plugin-apollo', '1.0.1')).toBe('plugin-apollo@1.0.1')
    expect(tagFor('@spaces/plugin-air-table', '2.0.0')).toBe(
      'plugin-air-table@2.0.0',
    )
    expect(tagFor(SDK_PACKAGE, '1.2.0')).toBe('sdk@1.2.0')
  })

  it('gives no tag to an internal package or a version that is not X.Y.Z', () => {
    expect(tagFor('@spaces/web', '0.1.0')).toBeNull()
    expect(tagFor('@spaces/core', '0.0.0')).toBeNull()
    expect(tagFor(CORE_PACKAGE, '1.2')).toBeNull()
    expect(tagFor('@spaces/plugin-apollo', '1.0.1-rc.1')).toBeNull()
  })

  it('names core exactly as release.yml checks it', () => {
    const tag = tagFor(CORE_PACKAGE, '0.2.0') ?? ''
    expect(RELEASE_YML_TAG.exec(tag)?.slice(1)).toEqual(['0', '2', '0'])
  })

  it('parses a plugin tag back, and nothing else', () => {
    expect(parsePluginTag('plugin-apollo@1.0.1')).toEqual({
      id: 'apollo',
      version: '1.0.1',
    })
    expect(parsePluginTag('plugin-air-table@2.0.0')?.id).toBe('air-table')
    expect(parsePluginTag('@spaces/plugin-apollo@1.0.1')).toBeNull()
    expect(parsePluginTag('core@1.0.0')).toBeNull()
    expect(parsePluginTag('plugin-apollo@1.0')).toBeNull()
    expect(parsePluginTag('plugin-Apollo@1.0.0')).toBeNull()
    for (const id of realPlugins) {
      expect(
        parsePluginTag(tagFor(`@spaces/plugin-${id}`, '3.4.5') ?? ''),
      ).toEqual({ id, version: '3.4.5' })
    }
  })
})

describe('the workspace changesets versions', () => {
  let packages: Awaited<ReturnType<typeof workspacePackages>>
  let config: Awaited<ReturnType<typeof loadConfig>>
  beforeAll(async () => {
    packages = await workspacePackages()
    config = await loadConfig(packages)
  })

  it('is core, the sdk and each real plugin — every fixture and internal package is ignored', () => {
    expect(
      versionedPackages(packages, config)
        .map((p) => p.packageJson.name)
        .sort(),
    ).toEqual(
      [
        CORE_PACKAGE,
        SDK_PACKAGE,
        ...realPlugins.map((id) => `@spaces/plugin-${id}`),
      ].sort(),
    )
    const fixtures = packages.packages.filter((p) =>
      p.dir.includes(`${path.sep}_fixtures${path.sep}`),
    )
    expect(fixtures.length).toBeGreaterThan(0)
    for (const p of fixtures)
      expect(config.ignore).toContain(p.packageJson.name)
  })

  it('versions every line independently', () => {
    expect(config.fixed).toEqual([])
    expect(config.linked).toEqual([])
  })

  it('bumps only apollo for an apollo changeset', () => {
    const plan = releasePlanFor(
      [changeset('apollo-fix', { '@spaces/plugin-apollo': 'patch' })],
      packages,
      config,
    )
    expect(plan.releases.map((r) => [r.name, r.type])).toEqual([
      ['@spaces/plugin-apollo', 'patch'],
    ])
  })

  it('bumps only core for a core changeset', () => {
    const plan = releasePlanFor(
      [changeset('core-feature', { [CORE_PACKAGE]: 'minor' })],
      packages,
      config,
    )
    expect(plan.releases.map((r) => [r.name, r.type])).toEqual([
      [CORE_PACKAGE, 'minor'],
    ])
  })

  it('bumps only the sdk for an sdk minor — plugins on workspace:* are not dragged along', () => {
    const plan = releasePlanFor(
      [changeset('sdk-port', { [SDK_PACKAGE]: 'minor' })],
      packages,
      config,
    )
    expect(plan.releases.map((r) => r.name)).toEqual([SDK_PACKAGE])
  })

  it('keeps each manifest version and SDK_VERSION equal to package.json', () => {
    expect(spelledVersionDrift(versionedPackages(packages, config))).toEqual([])
  })

  it('has a tag for every versioned package, core at the root', () => {
    const candidates = tagCandidates(packages, config)
    const core = candidates.find((c) => c.name === CORE_PACKAGE)
    expect(core?.relativeDir).toBe('')
    expect(core?.tag).toBe(`core@${packages.rootPackage?.packageJson.version}`)
  })
})

describe('tagsToCreate', () => {
  const candidates: Array<TagCandidate> = [
    {
      tag: 'core@0.1.0',
      name: CORE_PACKAGE,
      version: '0.1.0',
      relativeDir: '',
    },
    {
      tag: 'plugin-apollo@1.0.1',
      name: '@spaces/plugin-apollo',
      version: '1.0.1',
      relativeDir: 'plugins/apollo',
    },
    {
      tag: 'plugin-airtable@0.1.0',
      name: '@spaces/plugin-airtable',
      version: '0.1.0',
      relativeDir: 'plugins/airtable',
    },
    {
      tag: 'plugin-new@0.1.0',
      name: '@spaces/plugin-new',
      version: '0.1.0',
      relativeDir: 'plugins/new',
    },
  ]
  const base: Record<string, string> = {
    '': '0.1.0',
    'plugins/apollo': '1.0.0',
    'plugins/airtable': '0.1.0',
  }

  it('tags what the release bumped, and a package new since the base', () => {
    const created = tagsToCreate(candidates, {
      tagExists: (tag) => tag === 'core@0.1.0',
      versionAtBase: (dir) => base[dir] ?? null,
    })
    expect(created.map((c) => c.tag)).toEqual([
      'plugin-apollo@1.0.1',
      'plugin-new@0.1.0',
    ])
  })

  it('is a no-op once the tags exist', () => {
    expect(
      tagsToCreate(candidates, {
        tagExists: () => true,
        versionAtBase: () => null,
      }),
    ).toEqual([])
  })
})

describe('the manifest version line', () => {
  const source = `export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'apollo',
  version: '0.1.0',
  sdk: '^1.0',
})
`
  it('is read and rewritten in place', () => {
    expect(manifestVersionOf(source, 'm')).toBe('0.1.0')
    expect(withManifestVersion(source, '1.0.1', 'm')).toBe(
      source.replace("version: '0.1.0'", "version: '1.0.1'"),
    )
  })

  it('refuses a file with no version line, or two', () => {
    expect(() => manifestVersionOf('id: 1', 'm')).toThrow(/found 0/)
    expect(() =>
      manifestVersionOf(`${source}\n  version: '2.0.0',\n`, 'm'),
    ).toThrow(/found 2/)
  })
})

describe('versionPackages on a scratch workspace', () => {
  const write = (root: string, file: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), body)
  }
  const version = (root: string, dir: string): string =>
    readPackageJson(path.join(root, dir)).version

  const scratch = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spaces-changesets-'))
    write(
      root,
      'package.json',
      JSON.stringify({ name: CORE_PACKAGE, version: '0.1.0', private: true }),
    )
    write(
      root,
      'pnpm-workspace.yaml',
      "packages:\n  - 'packages/*'\n  - 'plugins/*'\n",
    )
    write(
      root,
      'packages/sdk/package.json',
      JSON.stringify({ name: SDK_PACKAGE, version: '1.1.0', private: true }),
    )
    write(
      root,
      'packages/sdk/src/version.ts',
      "export const SDK_VERSION = '1.1.0'\n",
    )
    write(
      root,
      'plugins/apollo/package.json',
      JSON.stringify({
        name: '@spaces/plugin-apollo',
        version: '1.0.0',
        private: true,
        dependencies: { [SDK_PACKAGE]: 'workspace:*' },
      }),
    )
    write(
      root,
      'plugins/apollo/src/manifest.ts',
      "export const manifest = {\n  id: 'apollo',\n  version: '1.0.0',\n}\n",
    )
    write(
      root,
      '.changeset/config.json',
      JSON.stringify({
        changelog: false,
        format: false,
        privatePackages: { version: true, tag: true },
      }),
    )
    return root
  }

  it('bumps apollo and its manifest line for an apollo changeset, and leaves core alone', async () => {
    const root = scratch()
    write(
      root,
      '.changeset/apollo-fix.md',
      "---\n'@spaces/plugin-apollo': patch\n---\n\nFix\n",
    )
    await versionPackages(root)
    expect(version(root, 'plugins/apollo')).toBe('1.0.1')
    expect(
      readFileSync(path.join(root, 'plugins/apollo/src/manifest.ts'), 'utf8'),
    ).toContain("version: '1.0.1',")
    expect(version(root, '.')).toBe('0.1.0')
    expect(existsSync(path.join(root, '.changeset/apollo-fix.md'))).toBe(false)
  })

  it('bumps core for a core changeset, and leaves apollo alone', async () => {
    const root = scratch()
    write(
      root,
      '.changeset/core-feature.md',
      `---\n'${CORE_PACKAGE}': minor\n---\n\nFeature\n`,
    )
    await versionPackages(root)
    expect(version(root, '.')).toBe('0.2.0')
    expect(version(root, 'plugins/apollo')).toBe('1.0.0')
  })

  it('bumps the sdk and SDK_VERSION for an sdk changeset, and re-releases no plugin', async () => {
    const root = scratch()
    write(
      root,
      '.changeset/sdk-port.md',
      `---\n'${SDK_PACKAGE}': minor\n---\n\nA port\n`,
    )
    await versionPackages(root)
    expect(version(root, 'packages/sdk')).toBe('1.2.0')
    expect(
      readFileSync(path.join(root, 'packages/sdk/src/version.ts'), 'utf8'),
    ).toBe("export const SDK_VERSION = '1.2.0'\n")
    expect(version(root, 'plugins/apollo')).toBe('1.0.0')
    expect(version(root, '.')).toBe('0.1.0')
  })
})
