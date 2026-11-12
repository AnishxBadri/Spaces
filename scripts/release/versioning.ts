import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getPackages } from '@manypkg/get-packages'
import type { Package, Packages } from '@manypkg/get-packages'
import { z } from 'zod'

/**
 * Release versioning: which packages carry a version line, what their tags
 * are called, and the bump that moves one.
 *
 * - Independent lines: core (the root package `spaces`), `@spaces/sdk` and
 *   each `plugins/<id>`. A fixture under `plugins/_fixtures/` and every
 *   other package carry none.
 * - A line moves only when its own package.json does: an sdk release
 *   re-releases no plugin, because a plugin leaves `@spaces/sdk` to the host
 *   at runtime and its manifest's `sdk` range is the compatibility claim.
 */

export const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** The root package's name; its version is core's (`core@X.Y.Z`). */
export const CORE_PACKAGE = 'spaces'
export const SDK_PACKAGE = '@spaces/sdk'
const PLUGIN_PACKAGE = /^@spaces\/plugin-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** The fields of a package.json the release scripts read. */
export const packageJsonSchema = z.object({
  name: z.string(),
  version: z.string(),
  scripts: z.record(z.string(), z.string()).optional(),
})
export type PackageJson = z.output<typeof packageJsonSchema>

export const parsePackageJson = (text: string): PackageJson =>
  packageJsonSchema.parse(JSON.parse(text))

export const readPackageJson = (dir: string): PackageJson =>
  parsePackageJson(readFileSync(path.join(dir, 'package.json'), 'utf8'))

export const pluginIdOf = (packageName: string): string | null =>
  PLUGIN_PACKAGE.exec(packageName)?.[1] ?? null

/**
 * The git tag a package version is released under. `core@` is what the image
 * workflow fires on and `plugin-<id>@` the plugin workflow; `sdk@` only
 * records the contract version. null for a package no line releases.
 */
export const tagFor = (packageName: string, version: string): string | null => {
  if (!SEMVER.test(version)) return null
  if (packageName === CORE_PACKAGE) return `core@${version}`
  if (packageName === SDK_PACKAGE) return `sdk@${version}`
  const id = pluginIdOf(packageName)
  return id === null ? null : `plugin-${id}@${version}`
}

/** `plugin-<id>@X.Y.Z` → its parts; null for any other spelling. */
export const parsePluginTag = (
  tag: string,
): { readonly id: string; readonly version: string } | null => {
  const at = tag.lastIndexOf('@')
  if (at < 0 || !tag.startsWith('plugin-')) return null
  const id = pluginIdOf(`@spaces/${tag.slice(0, at)}`)
  const version = tag.slice(at + 1)
  return id !== null && SEMVER.test(version) ? { id, version } : null
}

/** Every workspace package, plus the root package (core). */
export const workspacePackages = async (
  root: string = ROOT,
): Promise<Packages> => {
  const found = await getPackages(root)
  if (!found.rootPackage) throw new Error(`${root} has no root package.json`)
  return {
    ...found,
    packages: [found.rootPackage, ...found.packages],
  }
}

const FIXTURES = path.join('plugins', '_fixtures') + path.sep

/** The packages that carry a version line: core, the sdk, each real plugin. */
export const versionedPackages = (packages: Packages): Array<Package> =>
  packages.packages.filter((p) => {
    const { name } = p.packageJson
    if (name === CORE_PACKAGE || name === SDK_PACKAGE) return true
    if (pluginIdOf(name) === null) return false
    return !path.relative(packages.rootDir, p.dir).startsWith(FIXTURES)
  })

// ---------------------------------------------------------------------------
// Versions spelled in source. Two lines repeat package.json's version, and a
// bump rewrites both so it cannot leave them behind:
// - a plugin's `manifest.ts` `version:` — the packed manifest.json carries it,
//   and the plugin workflow refuses a tag that disagrees with it;
// - the sdk's `SDK_VERSION`, which `package.test.ts` holds equal.

const MANIFEST_VERSION = /^([ \t]*version:[ \t]*)'([^']*)'(,?)[ \t]*$/gm
const SDK_VERSION_LINE = /^(export const SDK_VERSION = )'([^']*)'[ \t]*$/gm

const onlyMatch = (source: string, re: RegExp, what: string): string => {
  const found = [...source.matchAll(re)]
  if (found.length !== 1) {
    throw new Error(
      `${what}: expected exactly one version line, found ${found.length}`,
    )
  }
  return found[0]?.[2] ?? ''
}

export const manifestVersionOf = (source: string, what: string): string =>
  onlyMatch(source, MANIFEST_VERSION, what)

export const withManifestVersion = (
  source: string,
  version: string,
  what: string,
): string => {
  manifestVersionOf(source, what)
  return source.replace(MANIFEST_VERSION, `$1'${version}'$3`)
}

export const sdkVersionOf = (source: string, what: string): string =>
  onlyMatch(source, SDK_VERSION_LINE, what)

export const withSdkVersion = (
  source: string,
  version: string,
  what: string,
): string => {
  sdkVersionOf(source, what)
  return source.replace(SDK_VERSION_LINE, `$1'${version}'`)
}

/** The source file that repeats a package's version, if it has one. */
export const spelledVersionFile = (
  name: string,
  dir: string,
): { readonly file: string; readonly kind: 'manifest' | 'sdk' } | null => {
  if (name === SDK_PACKAGE) {
    return { file: path.join(dir, 'src', 'version.ts'), kind: 'sdk' }
  }
  if (pluginIdOf(name) !== null) {
    return { file: path.join(dir, 'src', 'manifest.ts'), kind: 'manifest' }
  }
  return null
}

const readSpelled = (file: string, kind: 'manifest' | 'sdk'): string => {
  const source = readFileSync(file, 'utf8')
  return kind === 'sdk'
    ? sdkVersionOf(source, file)
    : manifestVersionOf(source, file)
}

/** Each versioned package whose spelled version disagrees with package.json. */
export const spelledVersionDrift = (packages: Array<Package>): Array<string> =>
  packages.flatMap((pkg) => {
    const spelled = spelledVersionFile(pkg.packageJson.name, pkg.dir)
    if (spelled === null) return []
    const actual = readSpelled(spelled.file, spelled.kind)
    return actual === pkg.packageJson.version
      ? []
      : [
          `${path.relative(ROOT, spelled.file)} says ${actual}, ${pkg.packageJson.name} is ${pkg.packageJson.version}`,
        ]
  })

/** Rewrites each spelled version to the package.json beside it. */
export const syncSpelledVersions = (dirs: Array<string>): Array<string> => {
  const touched: Array<string> = []
  for (const dir of dirs) {
    const { name, version } = readPackageJson(dir)
    const spelled = spelledVersionFile(name, dir)
    if (spelled === null) continue
    const source = readFileSync(spelled.file, 'utf8')
    const next =
      spelled.kind === 'sdk'
        ? withSdkVersion(source, version, spelled.file)
        : withManifestVersion(source, version, spelled.file)
    if (next !== source) {
      writeFileSync(spelled.file, next)
      touched.push(spelled.file)
    }
  }
  return touched
}

// ---------------------------------------------------------------------------
// The bump. One package at a time, by hand: `patch`, `minor`, `major`, or the
// version itself.

const numbers = (version: string): [number, number, number] | null => {
  const parts = SEMVER.exec(version)
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : null
}

/** The version after a bump; `to` may also be an exact `X.Y.Z` above it. */
export const nextVersion = (version: string, to: string): string => {
  const now = numbers(version)
  if (now === null) throw new Error(`${version} is not X.Y.Z`)
  const [major, minor, patch] = now
  if (to === 'major') return `${major + 1}.0.0`
  if (to === 'minor') return `${major}.${minor + 1}.0`
  if (to === 'patch') return `${major}.${minor}.${patch + 1}`
  const next = numbers(to)
  if (next === null)
    throw new Error(`${to} is not patch, minor, major or X.Y.Z`)
  const first = next.findIndex((n, i) => n !== now[i])
  if (first < 0 || next[first] < now[first])
    throw new Error(`${to} is not above ${version}`)
  return to
}

/**
 * The versioned package a bump names: its package name, `core`, `sdk`, or a
 * plugin's id. Throws on a package that carries no version line.
 */
export const packageToBump = (packages: Packages, named: string): Package => {
  const name =
    named === 'core'
      ? CORE_PACKAGE
      : named === 'sdk'
        ? SDK_PACKAGE
        : named.startsWith('@') || named === CORE_PACKAGE
          ? named
          : `@spaces/plugin-${named}`
  const found = versionedPackages(packages).find(
    (p) => p.packageJson.name === name,
  )
  if (!found) throw new Error(`${named} carries no version line`)
  return found
}

// The field as written, wherever the file puts it: a re-serialise would
// reformat a package.json prettier owns.
const VERSION_FIELD = /("version"\s*:\s*)"[^"]*"/

/**
 * Moves one package's version: its package.json line in place, then the
 * version its source spells. Returns the old and the new version.
 */
export const bumpPackage = (
  dir: string,
  to: string,
): { readonly name: string; readonly from: string; readonly to: string } => {
  const file = path.join(dir, 'package.json')
  const source = readFileSync(file, 'utf8')
  const { name, version } = parsePackageJson(source)
  const next = nextVersion(version, to)
  if (!VERSION_FIELD.test(source))
    throw new Error(`${file} has no version line`)
  writeFileSync(file, source.replace(VERSION_FIELD, `$1"${next}"`))
  syncSpelledVersions([dir])
  return { name, from: version, to: next }
}

// ---------------------------------------------------------------------------
// Tags. A package is tagged when its version changed since the base commit
// (the push's parent) and that tag does not exist yet — so a push tags
// exactly what it bumped, and a re-run is a no-op.

export type TagCandidate = {
  readonly tag: string
  readonly name: string
  readonly version: string
  /** The package directory relative to the repo root ('' for the root). */
  readonly relativeDir: string
}

export const tagCandidates = (packages: Packages): Array<TagCandidate> =>
  versionedPackages(packages).map((pkg) => {
    const { name, version } = pkg.packageJson
    const tag = tagFor(name, version)
    if (tag === null) {
      throw new Error(
        `${name}@${version} is versioned but has no tag line — give it one in tagFor`,
      )
    }
    const relativeDir = path.relative(packages.rootDir, pkg.dir)
    return { tag, name, version, relativeDir }
  })

export const tagsToCreate = (
  candidates: Array<TagCandidate>,
  git: {
    readonly tagExists: (tag: string) => boolean
    /** The version at the base commit; null when the package was not there. */
    readonly versionAtBase: (relativeDir: string) => string | null
  },
): Array<TagCandidate> =>
  candidates.filter(
    (c) =>
      !git.tagExists(c.tag) && git.versionAtBase(c.relativeDir) !== c.version,
  )
