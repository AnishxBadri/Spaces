import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { manifestSchema } from '@spaces/sdk'
import { keyIdOf, registryEntrySchema } from '@spaces/sdk/pack'
import type { RegistryEntry } from '@spaces/sdk/pack'
import {
  artifactNames,
  artifactsIn,
  checkRegistry,
  formatRegistry,
  lineDiff,
  parseRegistry,
  releaseBaseUrl,
  trustFrom,
  upsertEntry,
} from './registry.ts'
import type { Upsert } from './registry.ts'
import { parsePluginTag, readPackageJson } from './versioning.ts'

/**
 * One plugin release, from a built `plugins/<id>` to a committed registry
 * entry. The packing is the plugin's own `pack:plugin` (the sdk packer); this
 * only drives it and checks what it made.
 *
 * - Push mode (the workflow): sign with `SPACES_PLUGIN_SIGNING_KEY`, refuse a
 *   key `plugin-keys/` does not hold, create the GitHub release, download it
 *   back, run `checkRegistry` against the download, then commit registry.json
 *   on main. `registryFile` must sit in a checkout the workflow owns: the
 *   commit step resets it to origin/main.
 * - Dry run (`push: false`): sign with a throwaway key and write the tarball,
 *   the signature, the updated registry.json and its diff to `outDir`, checked
 *   against the local artifacts. Nothing leaves the machine.
 */

export type ReleaseOptions = {
  readonly id: string
  readonly pluginDir: string
  /** `plugin-<id>@X.Y.Z`; the tag the workflow fired on, or the pretend one. */
  readonly tag: string
  readonly outDir: string
  /** The registry.json to update — in place when pushing, a copy when not. */
  readonly registryFile: string
  readonly keysDir: string
  readonly repo: string
  readonly push: boolean
  /** PEM; required when pushing, ignored on a dry run. */
  readonly signingKey?: string
  readonly log?: (line: string) => void
}

export type ReleaseResult = {
  readonly entry: RegistryEntry
  readonly change: Upsert['change']
  readonly diff: string
  /** The files the release carries, in `outDir`. */
  readonly files: Array<string>
}

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, 'utf8'))

/** Every refusal that must come before a byte is packed. */
export const preflight = async (
  options: Pick<ReleaseOptions, 'id' | 'pluginDir' | 'tag'>,
): Promise<{ readonly version: string; readonly packScript: string }> => {
  const { id, pluginDir, tag } = options
  const parsed = parsePluginTag(tag)
  if (parsed === null) throw new Error(`${tag} is not plugin-<id>@X.Y.Z`)
  if (parsed.id !== id) throw new Error(`${tag} names ${parsed.id}, not ${id}`)

  const { name, version, scripts } = readPackageJson(pluginDir)
  if (name !== `@spaces/plugin-${id}`) {
    throw new Error(`${pluginDir} is ${name}, not @spaces/plugin-${id}`)
  }
  if (version !== parsed.version) {
    throw new Error(
      `the tag says ${parsed.version} and ${name} says ${version} — the tag and the code must agree`,
    )
  }
  const packScript = scripts?.['pack:plugin']
  if (packScript === undefined) {
    throw new Error(`${name} has no pack:plugin script`)
  }

  const built = path.join(pluginDir, 'dist', 'manifest.json')
  if (!existsSync(built)) {
    throw new Error(
      `${built} is missing — build first: pnpm exec turbo run build --filter=${name}`,
    )
  }
  const manifest = manifestSchema.parse(await readJson(built))
  if (manifest.id !== id || manifest.version !== version) {
    throw new Error(
      `the built manifest is ${manifest.id}@${manifest.version}, the package ${id}@${version} — rebuild, or run pnpm release:version to sync the manifest`,
    )
  }
  return { version, packScript }
}

/** Runs the plugin's `pack:plugin` as `pnpm run` would, with extra flags. */
const runPack = (
  pluginDir: string,
  packScript: string,
  args: Array<string>,
  env: NodeJS.ProcessEnv,
): string =>
  execFileSync('sh', ['-c', `${packScript} "$@"`, 'pack:plugin', ...args], {
    cwd: pluginDir,
    env: {
      ...env,
      PATH: `${path.join(pluginDir, 'node_modules', '.bin')}${path.delimiter}${env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })

const run = (cmd: string, args: Array<string>, cwd: string): string =>
  execFileSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })

export const releasePlugin = async (
  options: ReleaseOptions,
): Promise<ReleaseResult> => {
  const log = options.log ?? ((line: string) => console.info(line))
  const { id, pluginDir, tag, outDir, push } = options
  const { version, packScript } = await preflight(options)
  await mkdir(outDir, { recursive: true })

  // The key: the release secret, or a throwaway pair whose public half the
  // dry run trusts beside plugin-keys/.
  const keysDirs = [options.keysDir]
  const packArgs = [
    '--out',
    outDir,
    '--base-url',
    releaseBaseUrl(options.repo, tag),
  ]
  const { SPACES_PLUGIN_SIGNING_KEY: _ambient, ...packEnv } = process.env
  if (push) {
    if (!options.signingKey) {
      throw new Error(
        'SPACES_PLUGIN_SIGNING_KEY is not set — a release is never packed unsigned',
      )
    }
    packEnv.SPACES_PLUGIN_SIGNING_KEY = options.signingKey
  } else {
    const throwaway = generateKeyPairSync('ed25519')
    const keysDir = path.join(outDir, 'throwaway-keys')
    await mkdir(keysDir, { recursive: true })
    await writeFile(
      path.join(keysDir, `${keyIdOf(throwaway.publicKey)}.pub`),
      throwaway.publicKey.export({ format: 'pem', type: 'spki' }),
    )
    const keyFile = path.join(outDir, 'throwaway.key')
    await writeFile(
      keyFile,
      throwaway.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600 },
    )
    keysDirs.push(keysDir)
    packArgs.push('--key', keyFile)
  }
  log(runPack(pluginDir, packScript, packArgs, packEnv).trimEnd())

  const names = artifactNames(id, version)
  const entry = registryEntrySchema.parse(
    await readJson(path.join(outDir, names.entry)),
  )
  const trust = await trustFrom(keysDirs)
  if (push && !trust.keys.has(entry.keyId)) {
    throw new Error(
      `the signing key is ${entry.keyId}, and plugin-keys/ does not hold ${entry.keyId}.pub — commit it first (scripts/plugin-key.ts), or the image cannot verify this release`,
    )
  }

  const before = await readFile(options.registryFile, 'utf8')
  const upsert = upsertEntry(parseRegistry(before), entry)
  const after = await formatRegistry(upsert.registry, options.registryFile)
  const diff = lineDiff(before, after)
  const label = `${id}@${version}`
  const check = async (dir: string, where: string) => {
    const result = await checkRegistry({
      registry: upsert.registry,
      repo: options.repo,
      trust,
      artifacts: artifactsIn(dir),
      expect: [label],
    })
    if (result.problems.length > 0) {
      throw new Error(
        `registry.json would not match ${where}:\n${result.problems.map((p) => `  - ${p}`).join('\n')}`,
      )
    }
    log(
      `checked  registry.json against ${where}: ${result.verified.join(', ')}`,
    )
  }
  await check(outDir, 'the packed artifacts')

  const files = [names.tarball, names.sha256, names.sig, names.entry]
  if (!push) {
    await writeFile(path.join(outDir, 'registry.json'), after)
    await writeFile(path.join(outDir, 'registry.diff'), diff)
    log(`dry run  registry.json ${upsert.change} ${label}:\n${diff}`)
    log(`dry run  nothing pushed; ${files.join(', ')} are in ${outDir}`)
    return { entry, change: upsert.change, diff, files }
  }

  // The release, then the same check against what it serves.
  const repoDir = path.dirname(options.registryFile)
  const gh = (...args: Array<string>) =>
    run('gh', [...args, '--repo', options.repo], repoDir)
  const assets = files.map((f) => path.join(outDir, f))
  let released = true
  try {
    gh('release', 'view', tag)
  } catch {
    released = false
  }
  if (released) {
    gh('release', 'upload', tag, ...assets, '--clobber')
  } else {
    gh(
      'release',
      'create',
      tag,
      ...assets,
      '--verify-tag',
      '--title',
      tag,
      '--notes',
      `${entry.name} ${version}, signed by ${entry.keyId}. sha256 ${entry.sha256}.`,
    )
  }
  const downloaded = mkdtempSync(path.join(tmpdir(), `${id}-release-`))
  gh('release', 'download', tag, '--dir', downloaded)
  await check(downloaded, `the ${tag} release`)

  // The commit goes on main as it is now, not as it was at the tag: re-read,
  // upsert, commit, push; on a lost race, start again from main.
  for (let attempt = 1; ; attempt++) {
    run('git', ['fetch', 'origin', 'main'], repoDir)
    run('git', ['reset', '--hard', 'origin/main'], repoDir)
    const current = await readFile(options.registryFile, 'utf8')
    const next = upsertEntry(parseRegistry(current), entry)
    if (next.change === 'unchanged') {
      log(`registry.json on main already holds ${label}; nothing to commit`)
      return { entry, change: next.change, diff: '', files }
    }
    const text = await formatRegistry(next.registry, options.registryFile)
    await writeFile(options.registryFile, text)
    run('git', ['add', path.basename(options.registryFile)], repoDir)
    run('git', ['commit', '-m', `${tag}: registry.json entry`], repoDir)
    try {
      run('git', ['push', 'origin', 'HEAD:main'], repoDir)
      const pushed = lineDiff(current, text)
      log(`pushed   registry.json ${next.change} ${label}:\n${pushed}`)
      return { entry, change: next.change, diff: pushed, files }
    } catch (cause) {
      if (attempt === 3) throw cause
      log(`push refused (attempt ${attempt}); starting again from main`)
    }
  }
}
