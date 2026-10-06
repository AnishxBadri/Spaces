import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RegistryEntry } from '@spaces/sdk/pack'
import { beforeAll, describe, expect, it } from 'vitest'
import { preflight, releasePlugin } from './plugin.ts'
import type { ReleaseResult } from './plugin.ts'
import {
  DEFAULT_REPO,
  artifactsIn,
  checkRegistry,
  lineDiff,
  parseRegistry,
  readRegistry,
  trustFrom,
  upsertEntry,
} from './registry.ts'
import { ROOT, readPackageJson } from './versioning.ts'

const REGISTRY = path.join(ROOT, 'registry.json')
const KEYS = path.join(ROOT, 'plugin-keys')
const ECHO = path.join(ROOT, 'plugins', '_fixtures', 'echo')
const echoVersion = readPackageJson(ECHO).version
const echoTag = `plugin-echo@${echoVersion}`

/**
 * The half of the registry-sync invariant `pnpm test` can run. The committed
 * registry.json — the snapshot Dockerfile copies into the image — must parse,
 * name keys the image holds and point at its own releases. Whether each
 * entry equals what its release published is checked by the plugin workflow
 * against the downloaded release, before it commits; here the same check
 * runs against a local dry-run pack of the echo fixture.
 */
describe('the committed registry.json', () => {
  it('parses, names only keys plugin-keys/ holds, and points at its releases', async () => {
    const result = await checkRegistry({
      registry: await readRegistry(REGISTRY),
      repo: DEFAULT_REPO,
      trust: await trustFrom([KEYS]),
      artifacts: () => Promise.resolve(null),
    })
    expect(result.problems).toEqual([])
  })

  it('trusts every key file plugin-keys/ ships — none is mislabelled', async () => {
    const files = readdirSync(KEYS).filter((f) => f.endsWith('.pub'))
    expect((await trustFrom([KEYS])).keys.size).toBe(files.length)
  })
})

describe('the --no-push dry run, on the echo fixture', () => {
  let out: string
  let result: ReleaseResult
  let registryBefore: string
  beforeAll(async () => {
    if (!existsSync(path.join(ECHO, 'dist', 'manifest.json'))) {
      throw new Error(
        'build the echo fixture first: pnpm exec turbo run build --filter=@spaces/plugin-echo',
      )
    }
    registryBefore = readFileSync(REGISTRY, 'utf8')
    out = mkdtempSync(path.join(tmpdir(), 'spaces-release-dry-'))
    result = await releasePlugin({
      id: 'echo',
      pluginDir: ECHO,
      tag: echoTag,
      outDir: out,
      registryFile: REGISTRY,
      keysDir: KEYS,
      repo: DEFAULT_REPO,
      push: false,
      log: () => {},
    })
  })

  const trusted = () => trustFrom([KEYS, path.join(out, 'throwaway-keys')])
  const dryRegistry = () =>
    parseRegistry(readFileSync(path.join(out, 'registry.json'), 'utf8'))
  const check = async (registry: Array<RegistryEntry>) =>
    checkRegistry({
      registry,
      repo: DEFAULT_REPO,
      trust: await trusted(),
      artifacts: artifactsIn(out),
    })

  it('produces the tarball, its sha256, the signature, the entry, and the registry diff', () => {
    for (const file of [
      `echo-${echoVersion}.tgz`,
      `echo-${echoVersion}.tgz.sha256`,
      `echo-${echoVersion}.tgz.sig`,
      `echo-${echoVersion}.json`,
      'registry.json',
      'registry.diff',
    ]) {
      expect(existsSync(path.join(out, file)), file).toBe(true)
    }
    expect(result.change).toBe('added')
    expect(result.diff).toContain('+     "id": "echo",')
    expect(readFileSync(path.join(out, 'registry.diff'), 'utf8')).toBe(
      result.diff,
    )
    expect(result.entry.tarball).toBe(
      `https://github.com/${DEFAULT_REPO}/releases/download/${echoTag}/echo-${echoVersion}.tgz`,
    )
  })

  it('leaves the committed registry.json alone', () => {
    expect(readFileSync(REGISTRY, 'utf8')).toBe(registryBefore)
  })

  it('writes a registry.json whose entry is the published one, verified by core', async () => {
    const registry = dryRegistry()
    expect(registry.at(-1)).toEqual(result.entry)
    const checked = await check(registry)
    expect(checked.problems).toEqual([])
    expect(checked.verified).toEqual([`echo@${echoVersion}`])
  })

  it('catches a registry entry whose sha256 drifted from the artifact', async () => {
    const registry = dryRegistry().map((e) => ({
      ...e,
      sha256: '0'.repeat(64),
    }))
    const { problems } = await check(registry)
    expect(problems.join('\n')).toMatch(/differs from the published/)
    expect(problems.join('\n')).toMatch(/sha-mismatch/)
  })

  it('catches a signature the image cannot verify', async () => {
    const { problems } = await checkRegistry({
      registry: dryRegistry(),
      repo: DEFAULT_REPO,
      trust: await trustFrom([KEYS]),
      artifacts: artifactsIn(out),
    })
    expect(problems.join('\n')).toMatch(/plugin-keys\/ does not hold/)
    expect(problems.join('\n')).toMatch(/unknown-key/)
  })

  it('catches an entry pointing anywhere but its own release', async () => {
    const registry = dryRegistry().map((e) => ({
      ...e,
      tarball: 'https://example.com/echo.tgz',
    }))
    const { problems } = await check(registry)
    expect(problems.join('\n')).toMatch(/tarball is https:\/\/example.com/)
  })

  it('catches a missing release asset when the entry is expected', async () => {
    const { problems } = await checkRegistry({
      registry: dryRegistry(),
      repo: DEFAULT_REPO,
      trust: await trusted(),
      artifacts: () => Promise.resolve(null),
      expect: [`echo@${echoVersion}`],
    })
    expect(problems).toEqual([
      `echo@${echoVersion}: no verified artifact for it`,
    ])
  })
})

describe('preflight refuses before anything is packed', () => {
  it('a tag that disagrees with package.json', async () => {
    await expect(
      preflight({ id: 'echo', pluginDir: ECHO, tag: 'plugin-echo@9.9.9' }),
    ).rejects.toThrow(/the tag and the code must agree/)
  })

  it('a tag for another plugin, or not a plugin tag at all', async () => {
    await expect(
      preflight({
        id: 'echo',
        pluginDir: ECHO,
        tag: `plugin-apollo@${echoVersion}`,
      }),
    ).rejects.toThrow(/names apollo/)
    await expect(
      preflight({ id: 'echo', pluginDir: ECHO, tag: `core@${echoVersion}` }),
    ).rejects.toThrow(/not plugin-<id>@X.Y.Z/)
  })
})

describe('upsertEntry and lineDiff', () => {
  const entry = (version: string, sha: string): RegistryEntry => ({
    id: 'echo',
    version,
    sdk: '^1.0',
    name: 'Echo',
    description: 'Echo.',
    tarball: `https://github.com/${DEFAULT_REPO}/releases/download/plugin-echo@${version}/echo-${version}.tgz`,
    sha256: sha.repeat(64),
    sig: 'c2ln',
    keyId: 'ed25519-0000000000000000',
  })

  it('appends a new version, replaces the same one, and knows when nothing changed', () => {
    const one = upsertEntry([], entry('1.0.0', 'a'))
    expect(one.change).toBe('added')
    const two = upsertEntry(one.registry, entry('1.0.1', 'b'))
    expect(two.registry.map((e) => e.version)).toEqual(['1.0.0', '1.0.1'])
    const again = upsertEntry(two.registry, entry('1.0.1', 'b'))
    expect(again.change).toBe('unchanged')
    const fixed = upsertEntry(two.registry, entry('1.0.0', 'c'))
    expect(fixed.change).toBe('replaced')
    expect(fixed.registry.map((e) => e.sha256[0])).toEqual(['c', 'b'])
  })

  it('marks added and removed lines', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nx\nc\n')).toBe(
      '  … 1 unchanged line\n- b\n+ x\n  … 2 unchanged lines\n',
    )
  })
})
