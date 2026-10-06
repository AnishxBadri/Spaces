import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { and, eq, isNull, notLike } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import { compareVersions, newestPerPlugin } from '@spaces/core/plugins/registry'
import {
  installPlugin,
  uninstallPlugin,
  upgradePlugin,
} from '@spaces/core/writes/plugins/install'
import type { InstallerError } from '@spaces/core/writes/plugins/install'
import type { RegistryEntry } from '@spaces/sdk/pack'
import { requireAdmin } from '#/lib/server/shared'
import { IntegrationRefused, run } from './admin'
import { manifestOf } from './ledger'
import { readRegistryProgram } from './registry'
import type { RegistrySource } from './registry'

/**
 * Settings → Integrations, the registry half: what the committed
 * `registry.json` offers, and Install / Update / Uninstall. Web fetches the
 * tarball and hands the bytes to core's installer; it never runs plugin code.
 * - Each installer entry point has exactly one caller, here, behind one
 *   server fn (asserted by `installer-callers.test.ts`).
 * - `RegistrySource` exists so tests point it at a registry and tarballs on
 *   disk; the server fns pass none.
 */

/** One plugin the registry offers that this box has not installed. */
export type AvailablePlugin = {
  readonly pluginId: string
  readonly name: string
  readonly description: string
  readonly version: string
  /** What it will ask for once installed: `Apollo key`, `connect your own`, `no key`. */
  readonly needs: string
}

export type RegistryView = {
  readonly available: ReadonlyArray<AvailablePlugin>
  /** Why the registry could not be read; the list is then empty. */
  readonly error: string | null
}

export type InstallOutcome = {
  readonly name: string
  readonly version: string | null
  /** `unsigned (allowed by .allow-unsigned)`, when that is how it verified. */
  readonly warning: string | null
}

/** 64 MiB: a plugin is a bundle and a few migrations. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

const fetchTarball = async (url: string): Promise<Uint8Array> => {
  if (url.startsWith('file:')) return readFile(fileURLToPath(url))
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MAX_TARBALL_BYTES)
    throw new Error(`${url} is larger than a plugin can be`)
  return bytes
}

const refused = (message: string) => new IntegrationRefused({ message })

const needsOf = (entry: RegistryEntry): string => {
  if (entry.requires?.connection) return 'connect your own'
  if (entry.requires?.credential) return `${entry.name} key`
  return 'no key'
}

const liveRows = (only?: string) =>
  db
    .select({
      id: integration.id,
      capabilityId: integration.capabilityId,
      version: integration.version,
      manifest: integration.manifest,
    })
    .from(integration)
    .where(
      and(
        isNull(integration.removedAt),
        notLike(integration.capabilityId, 'core.%'),
        only === undefined ? undefined : eq(integration.id, only),
      ),
    )

/** The Available pane: the newest version of each plugin not installed here. */
export const availableProgram = Effect.fn('availableProgram')(function* (
  source: RegistrySource = {},
): Effect.fn.Return<RegistryView, IntegrationRefused> {
  const read = yield* readRegistryProgram(source).pipe(Effect.result)
  if (read._tag === 'Failure')
    return { available: [], error: read.failure.message }
  const installed = new Set(
    (yield* Effect.tryPromise({
      try: () => liveRows(),
      catch: () => refused('Could not read the installed plugins'),
    })).map((r) => r.capabilityId),
  )
  return {
    available: newestPerPlugin(read.success)
      .filter((e) => !installed.has(e.id))
      .map((e) => ({
        pluginId: e.id,
        name: e.name,
        description: e.description,
        version: e.version,
        needs: needsOf(e),
      })),
    error: null,
  }
})

/** The installer's failure as the sentence the operator reads. */
const sentence = (error: InstallerError): IntegrationRefused =>
  refused(
    error._tag === 'PluginRefused'
      ? `Refused (${error.code}): ${error.reason}`
      : error.message,
  )

/** The newest entry for one plugin, its bytes, and the trust to check them with. */
const fetchNewest = Effect.fn('fetchNewest')(function* (
  pluginId: string,
  source: RegistrySource,
) {
  const entries = yield* readRegistryProgram(source).pipe(
    Effect.mapError((e) => refused(e.message)),
  )
  const entry = newestPerPlugin(entries).find((e) => e.id === pluginId)
  if (entry === undefined)
    return yield* refused(`${pluginId} is not in the registry`)
  const tarball = yield* Effect.tryPromise({
    try: () => (source.fetchTarball ?? fetchTarball)(entry.tarball),
    catch: (cause) =>
      refused(
        `Could not fetch ${entry.name} ${entry.version}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })
  const trust = yield* loadPluginTrust({
    ...(source.keysDir === undefined ? {} : { keysDir: source.keysDir }),
    ...(source.dataDir === undefined ? {} : { dataDir: source.dataDir }),
  })
  return { entry, tarball, trust }
})

const installerOptions = (source: RegistrySource) =>
  source.dataDir === undefined ? {} : { dataDir: source.dataDir }

const liveRow = Effect.fn('liveRow')(function* (id: string) {
  const row = (yield* Effect.tryPromise({
    try: () => liveRows(id),
    catch: () => refused('Could not read the installed plugins'),
  })).at(0)
  if (!row) return yield* refused('That integration is not installed')
  return row
})

/** Install the registry's newest version of a plugin; the worker enables it on NOTIFY. */
export const installFromRegistryProgram = Effect.fn(
  'installFromRegistryProgram',
)(function* (
  actorId: string | null,
  pluginId: string,
  source: RegistrySource = {},
): Effect.fn.Return<InstallOutcome, IntegrationRefused> {
  const { entry, tarball, trust } = yield* fetchNewest(pluginId, source)
  const done = yield* installPlugin(
    { tarball, entry, trust, actorId },
    installerOptions(source),
  ).pipe(Effect.mapError(sentence))
  return { name: entry.name, version: done.version, warning: done.warning }
})

/** Move an installed plugin to the registry's newest version. */
export const upgradeFromRegistryProgram = Effect.fn(
  'upgradeFromRegistryProgram',
)(function* (
  id: string,
  source: RegistrySource = {},
): Effect.fn.Return<InstallOutcome, IntegrationRefused> {
  const row = yield* liveRow(id)
  const { entry, tarball, trust } = yield* fetchNewest(row.capabilityId, source)
  if (compareVersions(entry.version, row.version) <= 0)
    return yield* refused(`${entry.name} ${row.version} is the newest version`)
  const done = yield* upgradePlugin(
    { tarball, entry, trust },
    installerOptions(source),
  ).pipe(Effect.mapError(sentence))
  return { name: entry.name, version: done.version, warning: done.warning }
})

/** Remove a plugin's files and key; its row stays, soft-deleted, for provenance. */
export const uninstallIntegrationProgram = Effect.fn(
  'uninstallIntegrationProgram',
)(function* (
  id: string,
  dropData: boolean,
  source: RegistrySource = {},
): Effect.fn.Return<InstallOutcome, IntegrationRefused> {
  const row = yield* liveRow(id)
  yield* uninstallPlugin(
    { pluginId: row.capabilityId, dropData },
    installerOptions(source),
  ).pipe(Effect.mapError(sentence))
  return {
    name: manifestOf(row.manifest)?.name ?? row.capabilityId,
    version: null,
    warning: null,
  }
})

export async function listAvailableHandler(): Promise<RegistryView> {
  await requireAdmin()
  return run(availableProgram())
}

export async function installIntegrationHandler(input: {
  readonly pluginId: string
}): Promise<InstallOutcome> {
  const actor = await requireAdmin()
  return run(installFromRegistryProgram(actor.id, input.pluginId))
}

export async function upgradeIntegrationHandler(input: {
  readonly id: string
}): Promise<InstallOutcome> {
  await requireAdmin()
  return run(upgradeFromRegistryProgram(input.id))
}

export async function uninstallIntegrationHandler(input: {
  readonly id: string
  readonly dropData: boolean
}): Promise<InstallOutcome> {
  await requireAdmin()
  return run(uninstallIntegrationProgram(input.id, input.dropData))
}
