import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq, isNull, notLike } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import { compareVersions, newestPerPlugin } from '@spaces/core/plugins/registry'
import {
  MAX_TARBALL_BYTES,
  fetchPluginTarball,
} from '@spaces/core/plugins/source'
import type { EntryToVerify } from '@spaces/core/plugins/verify'
import {
  installPlugin,
  uninstallPlugin,
  upgradePlugin,
} from '@spaces/core/writes/plugins/install'
import type { InstallerError } from '@spaces/core/writes/plugins/install'
import { registryEntrySchema } from '@spaces/sdk/pack'
import type { RegistryEntry } from '@spaces/sdk/pack'
import { requireAdmin, requireUser } from '#/lib/server/shared'
import { IntegrationRefused, run } from './admin'
import { manifestOf } from './ledger'
import { readRegistryProgram } from './registry'
import type { RegistrySource } from './registry'

/**
 * Settings → Integrations, the registry half: what the committed
 * `registry.json` offers, and Install / Update / Uninstall / Upload. Web
 * fetches the tarball (or takes an upload, for a box with no outbound
 * HTTPS) and hands the bytes to core's installer; it never runs plugin code.
 * - `installPlugin` is called by the registry install and the upload here,
 *   and by first boot; upgrade and uninstall have one caller each (asserted
 *   by `installer-callers.test.ts`).
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

const trustOf = (source: RegistrySource) =>
  loadPluginTrust({
    ...(source.keysDir === undefined ? {} : { keysDir: source.keysDir }),
    ...(source.dataDir === undefined ? {} : { dataDir: source.dataDir }),
  })

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
    try: () => (source.fetchTarball ?? fetchPluginTarball)(entry.tarball),
    catch: (cause) =>
      refused(
        `Could not fetch ${entry.name} ${entry.version}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })
  const trust = yield* trustOf(source)
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

/** A plugin uploaded from the operator's disk. */
export type PluginUpload = {
  /** The tarball's file name, `<id>-<version>.tgz` as the packer names it. */
  readonly tarballName: string
  readonly tarball: Uint8Array
  /** The `<id>-<version>.json` entry its release published; null for an unsigned build. */
  readonly entryText: string | null
}

const PACKED_NAME =
  /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/

/**
 * What an upload is verified against. With the release's entry: its sha256,
 * signature and key id, exactly as the registry would give them. Without
 * it: an unsigned entry named by the file, which verification refuses
 * unless `.allow-unsigned` exists.
 */
const uploadedEntry = Effect.fn('uploadedEntry')(function* (
  upload: PluginUpload,
): Effect.fn.Return<
  { readonly entry: EntryToVerify; readonly name: string },
  IntegrationRefused
> {
  if (upload.entryText === null) {
    const named = PACKED_NAME.exec(upload.tarballName)
    if (named === null)
      return yield* refused(
        'Name the tarball <id>-<version>.tgz, as the packer does, or add its .json entry',
      )
    const [, id, version] = named
    const sha256 = createHash('sha256').update(upload.tarball).digest('hex')
    return {
      name: id,
      entry: { id, version, sha256, sig: null, keyId: null },
    }
  }
  const text = upload.entryText
  const parsed = registryEntrySchema.safeParse(
    yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => refused('The .json beside the tarball is not JSON'),
    }),
  )
  if (!parsed.success)
    return yield* refused(
      'The .json beside the tarball is not the registry entry its release published',
    )
  return { name: parsed.data.name, entry: parsed.data }
})

/** Install an uploaded tarball through the same installer as a registry install. */
export const installFromUploadProgram = Effect.fn('installFromUploadProgram')(
  function* (
    actorId: string | null,
    upload: PluginUpload,
    source: RegistrySource = {},
  ): Effect.fn.Return<InstallOutcome, IntegrationRefused> {
    if (upload.tarball.length > MAX_TARBALL_BYTES)
      return yield* refused(
        `${upload.tarballName} is larger than a plugin can be`,
      )
    const { entry, name } = yield* uploadedEntry(upload)
    const trust = yield* trustOf(source)
    const done = yield* installPlugin(
      { tarball: upload.tarball, entry, trust, actorId },
      installerOptions(source),
    ).pipe(Effect.mapError(sentence))
    return { name, version: done.version, warning: done.warning }
  },
)

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

/** Any member reads the catalogue (D81); install and upload are the admin's. */
export async function listAvailableHandler(): Promise<RegistryView> {
  await requireUser()
  return run(availableProgram())
}

export async function installIntegrationHandler(input: {
  readonly pluginId: string
}): Promise<InstallOutcome> {
  const actor = await requireAdmin()
  return run(installFromRegistryProgram(actor.id, input.pluginId))
}

export async function uploadIntegrationHandler(input: {
  readonly tarball: File
  readonly entry: File | null
}): Promise<InstallOutcome> {
  const actor = await requireAdmin()
  // Refused before the bytes are copied, naming the file.
  if (input.tarball.size > MAX_TARBALL_BYTES)
    throw new Error(`${input.tarball.name} is larger than a plugin can be`)
  const entry = input.entry
  return run(
    installFromUploadProgram(actor.id, {
      tarballName: input.tarball.name,
      tarball: new Uint8Array(await input.tarball.arrayBuffer()),
      entryText: entry === null ? null : await entry.text(),
    }),
  )
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
