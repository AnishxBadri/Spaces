import { createHash } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Effect } from 'effect'
import * as prettier from 'prettier'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import type { PluginTrust } from '@spaces/core/plugins/verify'
import { verifyPlugin } from '@spaces/core/plugins/verify'
import { registryEntrySchema, registrySchema } from '@spaces/sdk/pack'
import type { RegistryEntry } from '@spaces/sdk/pack'

/**
 * registry.json — the committed index the image carries — and the check that
 * holds it to what a plugin release published.
 *
 * - An entry's tarball lives on the GitHub release of `plugin-<id>@<version>`
 *   beside `<id>-<version>.json`, the entry the packer wrote. The committed
 *   entry must equal that one, and the tarball must pass core's own
 *   `verifyPlugin` under the keys in `plugin-keys/` — the image's check, run
 *   before the entry is committed.
 */

export const DEFAULT_REPO = 'AnishxBadri/Spaces'

export const pluginTag = (id: string, version: string): string =>
  `plugin-${id}@${version}`

export const releaseBaseUrl = (repo: string, tag: string): string =>
  `https://github.com/${repo}/releases/download/${tag}`

export const artifactNames = (id: string, version: string) => {
  const tarball = `${id}-${version}.tgz`
  return {
    tarball,
    sha256: `${tarball}.sha256`,
    sig: `${tarball}.sig`,
    entry: `${id}-${version}.json`,
  }
}

export const parseRegistry = (text: string): Array<RegistryEntry> =>
  registrySchema.parse(JSON.parse(text))

export const readRegistry = async (
  file: string,
): Promise<Array<RegistryEntry>> => parseRegistry(await readFile(file, 'utf8'))

/** The file's bytes for a registry: JSON through the repo's prettier. */
export const formatRegistry = async (
  registry: Array<RegistryEntry>,
  file: string,
): Promise<string> =>
  prettier.format(JSON.stringify(registry), {
    ...(await prettier.resolveConfig(file)),
    parser: 'json',
  })

export type Upsert = {
  readonly registry: Array<RegistryEntry>
  readonly change: 'added' | 'replaced' | 'unchanged'
}

/** Adds the entry, or replaces the one with its id and version in place. */
export const upsertEntry = (
  registry: Array<RegistryEntry>,
  entry: RegistryEntry,
): Upsert => {
  const at = registry.findIndex(
    (e) => e.id === entry.id && e.version === entry.version,
  )
  if (at < 0) return { registry: [...registry, entry], change: 'added' }
  if (canonical(registry[at]) === canonical(entry)) {
    return { registry, change: 'unchanged' }
  }
  return {
    registry: registry.map((e, i) => (i === at ? entry : e)),
    change: 'replaced',
  }
}

/** JSON with sorted keys, so two equal entries compare equal as strings. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  )

/** A line diff of two texts, `+`/`-` on changed lines, unchanged runs elided. */
export const lineDiff = (before: string, after: string): string => {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest common subsequence table, from the end.
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] ?? []
      row[j] =
        a[i] === b[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: Array<string> = []
  let same = 0
  const flush = () => {
    if (same > 0) out.push(`  … ${same} unchanged line${same === 1 ? '' : 's'}`)
    same = 0
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      same++
      i++
      j++
    } else if (
      i < a.length &&
      (j >= b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      flush()
      out.push(`- ${a[i] ?? ''}`)
      i++
    } else {
      flush()
      out.push(`+ ${b[j] ?? ''}`)
      j++
    }
  }
  flush()
  return `${out.join('\n')}\n`
}

/** The keys in every given directory, as `loadPluginTrust` reads them. */
export const trustFrom = async (
  keysDirs: Array<string>,
): Promise<PluginTrust> => {
  const keys = new Map<string, KeyObject>()
  for (const keysDir of keysDirs) {
    // The escape marker is never honoured here: the data dir is one that
    // cannot hold it.
    const trust = await Effect.runPromise(
      loadPluginTrust({ keysDir, dataDir: path.join(keysDir, '.no-data') }),
    )
    for (const [id, key] of trust.keys) keys.set(id, key)
  }
  return { keys, allowUnsigned: false }
}

/** Where a check reads one release's published files from. */
export type Artifacts = (
  entry: RegistryEntry,
  name: string,
) => Promise<Uint8Array | null>

/** Published files in a local directory: a pack's out dir or a download. */
export const artifactsIn =
  (dir: string): Artifacts =>
  async (_entry, name) => {
    const file = path.join(dir, name)
    return existsSync(file) ? new Uint8Array(await readFile(file)) : null
  }

export type CheckResult = {
  readonly problems: Array<string>
  /** `id@version` of each entry whose artifacts were found and verified. */
  readonly verified: Array<string>
}

/**
 * The registry-sync invariant. Every entry parses, is unique, names a key
 * `plugin-keys/` holds, and points at its own release; every entry whose
 * artifacts are at hand equals the published entry and its tarball passes
 * `verifyPlugin`. Each `expect`ed `id@version` must be among those verified.
 */
export const checkRegistry = async (input: {
  readonly registry: Array<RegistryEntry>
  readonly repo: string
  readonly trust: PluginTrust
  readonly artifacts: Artifacts
  readonly expect?: Array<string>
}): Promise<CheckResult> => {
  const problems: Array<string> = []
  const verified: Array<string> = []
  const seen = new Set<string>()
  for (const entry of input.registry) {
    const label = `${entry.id}@${entry.version}`
    if (seen.has(label)) problems.push(`${label} is listed twice`)
    seen.add(label)

    const names = artifactNames(entry.id, entry.version)
    const where = `${releaseBaseUrl(input.repo, pluginTag(entry.id, entry.version))}/${names.tarball}`
    if (entry.tarball !== where) {
      problems.push(`${label}: tarball is ${entry.tarball}, not ${where}`)
    }
    if (!input.trust.keys.has(entry.keyId)) {
      problems.push(
        `${label}: signed by ${entry.keyId}, which plugin-keys/ does not hold — the image could not verify it`,
      )
    }

    const tarball = await input.artifacts(entry, names.tarball)
    const published = await input.artifacts(entry, names.entry)
    if (tarball === null || published === null) continue

    const publishedEntry = registryEntrySchema.safeParse(
      JSON.parse(new TextDecoder().decode(published)),
    )
    if (!publishedEntry.success) {
      problems.push(`${label}: the published ${names.entry} does not parse`)
    } else if (canonical(publishedEntry.data) !== canonical(entry)) {
      problems.push(
        `${label}: registry.json's entry differs from the published ${names.entry}`,
      )
    }

    const shaFile = await input.artifacts(entry, names.sha256)
    const sha = createHash('sha256').update(tarball).digest('hex')
    if (
      shaFile !== null &&
      new TextDecoder().decode(shaFile) !== `${sha}  ${names.tarball}\n`
    ) {
      problems.push(
        `${label}: the published ${names.sha256} does not name the tarball`,
      )
    }

    const refusal = await Effect.runPromise(
      verifyPlugin({ tarball, entry, trust: input.trust }).pipe(
        Effect.match({
          onFailure: (e) => `${e.code}: ${e.reason}`,
          onSuccess: () => null,
        }),
      ),
    )
    if (refusal !== null) problems.push(`${label}: ${refusal}`)
    else verified.push(label)
  }
  for (const label of input.expect ?? []) {
    if (!verified.includes(label)) {
      problems.push(`${label}: no verified artifact for it`)
    }
  }
  return { problems, verified }
}
