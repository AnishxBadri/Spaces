import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import { desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema/integrations'
import { isVersion, manifestSchema } from '@spaces/sdk'
import { LOCK_FILE, bundleSha256, lockSchema } from '@spaces/core/plugins/lock'
import type { Lock } from '@spaces/core/plugins/lock'
import { CORE_VERSION } from '@spaces/core/plugins/core-version'
import { verifyPlugin } from '@spaces/core/plugins/verify'
import type {
  EntryToVerify,
  PluginRefused,
  PluginTrust,
} from '@spaces/core/plugins/verify'
import { dataDir } from '../vault/key.ts'
import { releaseCredential } from './credential.ts'
import { dropPluginSchemaStatement } from './schema.ts'

/**
 * The installer: install, upgrade and uninstall, through one routine
 * (`runInstaller`). Web moves bytes and writes rows; it never runs plugin
 * code — the worker reloads on `plugin_changed`, sent after the commit.
 * - Verification comes first, so a refused tarball writes nothing: no
 *   directory, no lock.json edit, no row.
 * - Files land in `<data>/plugins/<id>/<version>/` by a rename from a staging
 *   directory, `current` is swapped by renaming a fresh symlink over it, and
 *   one version back is kept; older ones are removed.
 * - Uninstall soft-deletes the row (`removed_at`) and never deletes it, so
 *   every `source_ref` and `actor_ref` keeps naming the plugin. A reinstall of
 *   the same id clears `removed_at` on that row.
 * - Every run holds one advisory lock, so two never interleave on lock.json.
 */

/** The worker's LISTEN channel; the payload is the plugin id. */
export const PLUGIN_CHANGED = 'plugin_changed'

/** A refusal the operator can act on: already installed, not installed. */
export class InstallRefused extends Schema.TaggedError<InstallRefused>()(
  'InstallRefused',
  { message: Schema.String },
) {}

/** The disk or the database failed under the installer. */
export class InstallFailed extends Schema.TaggedError<InstallFailed>()(
  'InstallFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type InstallerError = PluginRefused | InstallRefused | InstallFailed

/** A tarball and the registry entry (or upload) that names it. */
export type PluginBytes = {
  readonly tarball: Uint8Array
  readonly entry: EntryToVerify
  readonly trust: PluginTrust
}

export type InstallerOp =
  | (PluginBytes & {
      readonly kind: 'install'
      /** The admin installing it; recorded on a new row. */
      readonly actorId: string | null
    })
  | (PluginBytes & { readonly kind: 'upgrade' })
  | {
      readonly kind: 'uninstall'
      readonly pluginId: string
      /** Also drop `plugin_<id>` and everything in it. */
      readonly dropData: boolean
    }

export type InstallerOptions = {
  /** Defaults to `dataDir()`; the plugins root is `<dataDir>/plugins`. */
  readonly dataDir?: string
  /** What lock.json records as `core`; defaults to `CORE_VERSION`. */
  readonly core?: string
}

export type InstallerResult = {
  readonly integrationId: string
  readonly pluginId: string
  /** The version now current; null after an uninstall. */
  readonly version: string | null
  /** The version `current` pointed at before an upgrade, kept one back. */
  readonly previous: string | null
  /** Set when the archive verified with a caveat (unsigned, allowed). */
  readonly warning: string | null
}

const STAGING = '.staging'

/** One key for every installer run, beside keyIntegration's per-plugin key. */
const INSTALLER_LOCK = 'plugins:installer'

const jsonRecord = z.record(z.string(), z.json())

const readLock = async (root: string): Promise<Lock> => {
  const file = path.join(root, LOCK_FILE)
  if (!existsSync(file)) return { plugins: {} }
  const parsed = lockSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
  if (!parsed.success)
    throw new InstallRefused({
      message: `${file} is invalid; fix or remove it before installing`,
    })
  return parsed.data
}

const writeLock = async (root: string, lock: Lock): Promise<void> => {
  const file = path.join(root, LOCK_FILE)
  const next = `${file}.${randomUUID()}`
  await writeFile(next, `${JSON.stringify(lock, null, 2)}\n`)
  await rename(next, file)
}

/** The version directory `current` points at, or null. */
const currentVersion = async (dir: string): Promise<string | null> => {
  try {
    return path.basename(await readlink(path.join(dir, 'current')))
  } catch {
    return null
  }
}

/** Writes the files to staging, then renames them into `<dir>/<version>`. */
const placeVersion = async (
  root: string,
  dir: string,
  version: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> => {
  const staging = path.join(root, STAGING, randomUUID())
  const trash = path.join(root, STAGING, randomUUID())
  try {
    for (const [rel, data] of files) {
      const file = path.join(staging, rel)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, data)
    }
    await mkdir(dir, { recursive: true })
    const target = path.join(dir, version)
    if (existsSync(target)) await rename(target, trash)
    await rename(staging, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(trash, { recursive: true, force: true })
  }
}

/** Points `current` at `version` in one rename; a hand-made directory there is replaced. */
const swapCurrent = async (dir: string, version: string): Promise<void> => {
  const link = path.join(dir, 'current')
  const stat = await lstat(link).catch(() => null)
  if (stat?.isDirectory()) await rm(link, { recursive: true, force: true })
  const next = path.join(dir, `current.${randomUUID()}`)
  await symlink(version, next)
  await rename(next, link)
}

/** Removes every version directory but the ones kept. */
const prune = async (
  dir: string,
  keep: ReadonlyArray<string | null>,
): Promise<void> => {
  for (const name of await readdir(dir)) {
    if (!isVersion(name) || keep.includes(name)) continue
    await rm(path.join(dir, name), { recursive: true, force: true })
  }
}

const notifyChanged = (pluginId: string) =>
  Effect.tryPromise({
    try: () =>
      db.execute(sql`select pg_notify(${PLUGIN_CHANGED}, ${pluginId})`),
    catch: (cause) =>
      new InstallFailed({
        message: `${pluginId} is installed, but the worker was not told`,
        cause,
      }),
  })

type Row = typeof integration.$inferSelect
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Holds the installer's locks for the transaction and reads the plugin's rows, newest first. */
const lockedRows = async (tx: Tx, pluginId: string) => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${INSTALLER_LOCK}))`,
  )
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`integration:${pluginId}`}))`,
  )
  const rows: Array<Row> = await tx
    .select()
    .from(integration)
    .where(eq(integration.capabilityId, pluginId))
    .orderBy(desc(integration.createdAt))
  return {
    live: rows.find((r) => r.removedAt === null),
    removed: rows.find((r) => r.removedAt !== null),
  }
}

/** Install or upgrade, once the bytes have verified. */
const put = async (
  op: Extract<InstallerOp, { kind: 'install' | 'upgrade' }>,
  files: ReadonlyMap<string, Uint8Array>,
  manifest: IntegrationManifest | null,
  root: string,
  core: string,
): Promise<Omit<InstallerResult, 'warning'>> => {
  const { id, version } = op.entry
  const bundle = files.get('bundle.mjs')
  if (bundle === undefined)
    throw new InstallRefused({
      message: `${id}@${version} has no bundle.mjs at its root`,
    })
  return db.transaction(async (tx) => {
    const { live, removed } = await lockedRows(tx, id)
    if (op.kind === 'install' && live)
      throw new InstallRefused({
        message: `${id} is already installed at ${live.version}; update it instead`,
      })
    if (op.kind === 'upgrade' && !live)
      throw new InstallRefused({ message: `${id} is not installed` })

    const lock = await readLock(root)
    const dir = path.join(root, id)
    const previous = await currentVersion(dir)
    await placeVersion(root, dir, version, files)
    await swapCurrent(dir, version)
    await prune(dir, [version, previous])
    await writeLock(root, {
      ...lock,
      core,
      plugins: {
        ...lock.plugins,
        [id]: { version, sha256: bundleSha256(bundle) },
      },
    })

    if (op.kind === 'upgrade' && live) {
      const tripped = live.status === 'disabled'
      await tx
        .update(integration)
        .set({
          version,
          manifest,
          ...(tripped ? {} : { status: 'installing', lastError: null }),
        })
        .where(eq(integration.id, live.id))
      return {
        integrationId: live.id,
        pluginId: id,
        version,
        previous: previous === version ? null : previous,
      }
    }
    const fresh = {
      version,
      manifest,
      enabled: true,
      status: 'installing' as const,
      lastError: null,
      errorCount: 0,
      removedAt: null,
    }
    if (removed) {
      await tx
        .update(integration)
        .set(fresh)
        .where(eq(integration.id, removed.id))
      return {
        integrationId: removed.id,
        pluginId: id,
        version,
        previous: null,
      }
    }
    const inserted = (
      await tx
        .insert(integration)
        .values({
          capabilityId: id,
          createdBy: op.kind === 'install' ? op.actorId : null,
          ...fresh,
        })
        .returning({ id: integration.id })
    ).at(0)
    if (!inserted) throw new Error('integration insert returned no row')
    return { integrationId: inserted.id, pluginId: id, version, previous: null }
  })
}

const remove = async (
  op: Extract<InstallerOp, { kind: 'uninstall' }>,
  root: string,
): Promise<Omit<InstallerResult, 'warning'>> => {
  const id = op.pluginId
  return db.transaction(async (tx) => {
    const { live } = await lockedRows(tx, id)
    if (!live) throw new InstallRefused({ message: `${id} is not installed` })
    await tx
      .update(integration)
      .set({
        removedAt: new Date(),
        enabled: false,
        credentialId: null,
        webhookCredentialId: null,
        ...(op.dropData ? { cursors: null } : {}),
      })
      .where(eq(integration.id, live.id))
    for (const held of [live.credentialId, live.webhookCredentialId])
      if (held !== null) await releaseCredential(tx, live.id, held)
    if (op.dropData) await tx.execute(dropPluginSchemaStatement(id))

    const lock = await readLock(root).catch(() => null)
    if (lock !== null && Object.hasOwn(lock.plugins, id)) {
      const plugins = Object.fromEntries(
        Object.entries(lock.plugins).filter(([key]) => key !== id),
      )
      await writeLock(root, { ...lock, plugins })
    }
    await rm(path.join(root, id), { recursive: true, force: true })
    return {
      integrationId: live.id,
      pluginId: id,
      version: null,
      previous: null,
    }
  })
}

/**
 * The one installer routine. `install`, `upgrade` and `uninstall` are its
 * only callers; each of those has one caller, the server fn behind its
 * button (asserted by test).
 */
export const runInstaller = Effect.fn('runInstaller')(function* (
  op: InstallerOp,
  options: InstallerOptions = {},
): Effect.fn.Return<InstallerResult, InstallerError> {
  const root = path.join(options.dataDir ?? dataDir(), 'plugins')
  const pluginId = op.kind === 'uninstall' ? op.pluginId : op.entry.id
  const failed = (cause: unknown) =>
    cause instanceof InstallRefused
      ? cause
      : new InstallFailed({
          message: `Could not ${op.kind} ${pluginId}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        })

  if (op.kind === 'uninstall') {
    const done = yield* Effect.tryPromise({
      try: () => remove(op, root),
      catch: failed,
    })
    yield* notifyChanged(pluginId)
    return { ...done, warning: null }
  }

  const verified = yield* verifyPlugin({
    tarball: op.tarball,
    entry: op.entry,
    trust: op.trust,
  })
  // Stored only as the loader would store it; the loader rewrites it on load.
  const manifest = manifestSchema.safeParse(verified.manifest).success
    ? jsonRecord.parse(verified.manifest)
    : null
  const done = yield* Effect.tryPromise({
    try: () =>
      put(op, verified.files, manifest, root, options.core ?? CORE_VERSION),
    catch: failed,
  })
  yield* notifyChanged(pluginId)
  return { ...done, warning: verified.warning }
})

/** Install a plugin the box does not have, or reinstall a removed one on its old row. */
export const installPlugin = (
  input: PluginBytes & { readonly actorId: string | null },
  options?: InstallerOptions,
) => runInstaller({ kind: 'install', ...input }, options)

/** Move an installed plugin to the version these bytes carry; the old one is kept one back. */
export const upgradePlugin = (input: PluginBytes, options?: InstallerOptions) =>
  runInstaller({ kind: 'upgrade', ...input }, options)

/** Remove the files and the key, keep the row (soft-deleted) for provenance. */
export const uninstallPlugin = (
  input: { readonly pluginId: string; readonly dropData: boolean },
  options?: InstallerOptions,
) => runInstaller({ kind: 'uninstall', ...input }, options)
