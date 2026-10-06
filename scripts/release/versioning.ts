import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { applyReleasePlan } from '@changesets/apply-release-plan'
import { assembleReleasePlan } from '@changesets/assemble-release-plan'
import { readConfig } from '@changesets/config'
import { readChangesets } from '@changesets/read'
import type {
  Config,
  NewChangeset,
  Package,
  Packages,
  ReleasePlan,
} from '@changesets/types'
import { getPackages } from '@manypkg/get-packages'
import { z } from 'zod'

/**
 * Release versioning: which packages carry a version line, what their tags
 * are called, and the changesets run that bumps them.
 *
 * - Independent lines: core (the root package `spaces`), `@spaces/sdk` and
 *   each `plugins/<id>`. `fixed` and `linked` stay empty, so a changeset
 *   bumps exactly the packages it names. Everything else is `ignore`d in
 *   `.changeset/config.json`.
 * - changesets does not see a monorepo's root package, so `versionPackages`
 *   hands it the root as one more package — the stock `changeset version`
 *   refuses a changeset naming `spaces`.
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

/** The workspace as changesets sees it, plus the root package (core). */
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

export const loadConfig = async (packages: Packages): Promise<Config> => {
  const result = await readConfig(packages.rootDir, packages)
  if (result.errors) {
    throw new Error(`.changeset/config.json: ${result.errors.join('; ')}`)
  }
  return result.config
}

/** The packages a changeset may name: every one not ignored. */
export const versionedPackages = (
  packages: Packages,
  config: Config,
): Array<Package> =>
  packages.packages.filter((p) => !config.ignore.includes(p.packageJson.name))

/**
 * changesets' plan, minus every release no changeset named. Those are the
 * dependents it would bump because a `workspace:*` dependency moved — every
 * plugin on an sdk minor — but a plugin leaves `@spaces/sdk` to the host at
 * runtime and its manifest's `sdk` range is the compatibility claim, so an
 * sdk release re-releases nothing.
 */
export const releasePlanFor = (
  changesets: Array<NewChangeset>,
  packages: Packages,
  config: Config,
): ReleasePlan => {
  const plan = assembleReleasePlan(changesets, packages, config, undefined)
  return {
    ...plan,
    releases: plan.releases.filter((r) => r.changesets.length > 0),
  }
}

// ---------------------------------------------------------------------------
// Versions spelled in source. Two lines repeat package.json's version, and the
// version run rewrites both so a bump cannot leave them behind:
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

/**
 * `changeset version` with the root visible: bump every package the pending
 * changesets name, delete the changesets, then rewrite the spelled versions.
 * Returns the plan it applied; an empty plan writes nothing.
 */
export const versionPackages = async (
  root: string = ROOT,
): Promise<ReleasePlan> => {
  const packages = await workspacePackages(root)
  const config = await loadConfig(packages)
  const plan = releasePlanFor(await readChangesets(root), packages, config)
  if (plan.releases.length === 0) return plan
  await applyReleasePlan(plan, packages, config)
  syncSpelledVersions(
    plan.releases
      .filter((r) => r.type !== 'none')
      .flatMap((r) => {
        const pkg = packages.packages.find((p) => p.packageJson.name === r.name)
        return pkg ? [pkg.dir] : []
      }),
  )
  return plan
}

// ---------------------------------------------------------------------------
// Tags. A package is tagged when its version changed since the base commit
// (the release PR's merge parent) and that tag does not exist yet — so the
// merge of a release PR tags exactly what it bumped, and a re-run is a no-op.

export type TagCandidate = {
  readonly tag: string
  readonly name: string
  readonly version: string
  /** The package directory relative to the repo root ('' for the root). */
  readonly relativeDir: string
}

export const tagCandidates = (
  packages: Packages,
  config: Config,
): Array<TagCandidate> =>
  versionedPackages(packages, config).map((pkg) => {
    const { name, version } = pkg.packageJson
    const tag = tagFor(name, version)
    if (tag === null) {
      throw new Error(
        `${name}@${version} is versioned but has no tag line — ignore it in .changeset/config.json or give it one in tagFor`,
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
