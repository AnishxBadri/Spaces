import { Effect } from 'effect'
import { and, isNull, notLike } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { THIS_HOST, updateFor } from '@spaces/core/plugins/registry'
import type { HostVersions } from '@spaces/core/plugins/registry'
import {
  fetchPluginTarball,
  readRegistryFile,
} from '@spaces/core/plugins/source'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import { upgradePlugin } from '@spaces/core/writes/plugins/install'

/**
 * `SPACES_PLUGINS_AUTOUPDATE=compatible`: at boot, before the loader runs,
 * every installed plugin takes the newest satisfying version the bundled
 * registry snapshot lists, through the same installer the Update button
 * runs. Each take is logged.
 * - Off unless the value is exactly `compatible`; unset or anything else
 *   takes nothing and says nothing. Not in the required-env set.
 * - In the worker, not web: it owns the data directory and the loader, and
 *   runs on every boot even when web is a separate container. Run before
 *   the first reconcile, the new version loads in that same boot.
 * - Never fails the boot: a refused or unreachable version is logged and
 *   the plugin keeps the version it has.
 */

export const AUTOUPDATE_ENV = 'SPACES_PLUGINS_AUTOUPDATE'

export type AutoupdateMode = 'compatible' | 'off'

/** The env value as a mode: only `compatible` turns it on. */
export const autoupdateModeOf = (value: string | undefined): AutoupdateMode =>
  value === 'compatible' ? 'compatible' : 'off'

export type AutoupdateOptions = {
  /** Defaults to the bundled `registry.json`. */
  readonly registryFile?: string
  /** Defaults to `fetchPluginTarball`. */
  readonly fetchTarball?: (url: string) => Promise<Uint8Array>
  /** Defaults to the image's `plugin-keys/`. */
  readonly keysDir?: string
  /** Defaults to `dataDir()`. */
  readonly dataDir?: string
  /** Defaults to this core and sdk. */
  readonly host?: HostVersions
  /** Defaults to the console. */
  readonly log?: (line: string) => void
}

/** One version taken: the plugin, from, to. */
export type Take = {
  readonly pluginId: string
  readonly from: string
  readonly to: string
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const autoupdatePlugins = Effect.fn('autoupdatePlugins')(function* (
  mode: AutoupdateMode,
  options: AutoupdateOptions = {},
): Effect.fn.Return<ReadonlyArray<Take>> {
  if (mode !== 'compatible') return []
  const log = options.log ?? ((line: string) => console.log(line))
  const read = yield* readRegistryFile(options.registryFile).pipe(Effect.result)
  if (read._tag === 'Failure') {
    log(`[plugins] autoupdate skipped: ${read.failure.message}`)
    return []
  }
  const rows = yield* Effect.tryPromise(() =>
    db
      .select({
        capabilityId: integration.capabilityId,
        version: integration.version,
      })
      .from(integration)
      .where(
        and(
          isNull(integration.removedAt),
          notLike(integration.capabilityId, 'core.%'),
        ),
      )
      .orderBy(integration.capabilityId),
  ).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log(`[plugins] autoupdate skipped: ${messageOf(error)}`)
        return []
      }),
    ),
  )
  const offers = rows.flatMap((row) => {
    const { target } = updateFor(
      read.success,
      row.capabilityId,
      row.version,
      options.host ?? THIS_HOST,
    )
    return target === null ? [] : [{ row, target }]
  })
  if (offers.length === 0) return []

  const trust = yield* loadPluginTrust({
    ...(options.keysDir === undefined ? {} : { keysDir: options.keysDir }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
  })
  const taken: Array<Take> = []
  for (const { row, target } of offers) {
    const id = row.capabilityId
    const done = yield* Effect.tryPromise({
      try: () => (options.fetchTarball ?? fetchPluginTarball)(target.tarball),
      catch: (error) =>
        `could not fetch ${target.tarball}: ${messageOf(error)}`,
    }).pipe(
      Effect.flatMap((tarball) =>
        upgradePlugin(
          { tarball, entry: target, trust },
          options.dataDir === undefined ? {} : { dataDir: options.dataDir },
        ).pipe(
          Effect.mapError((error) =>
            error._tag === 'PluginRefused'
              ? `refused (${error.code}): ${error.reason}`
              : error.message,
          ),
        ),
      ),
      Effect.result,
    )
    if (done._tag === 'Failure') {
      log(
        `[plugins] ${id}: autoupdate to ${target.version} failed, keeping ${row.version} — ${done.failure}`,
      )
      continue
    }
    const warning =
      done.success.warning === null ? '' : ` (${done.success.warning})`
    log(
      `[plugins] ${id}: autoupdate took ${target.version} over ${row.version}${warning}`,
    )
    taken.push({ pluginId: id, from: row.version, to: target.version })
  }
  return taken
})
