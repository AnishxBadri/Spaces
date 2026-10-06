import { Effect } from 'effect'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { manifestSchema } from '@spaces/sdk'
import type { RegistryEntry } from '@spaces/sdk/pack'
import { newestPerPlugin } from '@spaces/core/plugins/registry'
import {
  fetchPluginTarball,
  readRegistryFile,
} from '@spaces/core/plugins/source'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import {
  readWorkspaceCredential,
  redact,
  storeCredential,
} from '../vault/index.ts'
import { PLUGIN_CHANGED, installPlugin } from './install.ts'

/**
 * The two optional boot-time conveniences over the installer and the vault.
 * Both are inputs, never the store: the `integration` row and the vault row
 * are what the box runs on.
 * - `SPACES_PLUGINS=apollo,rss` installs each named plugin that has no live
 *   row, from the bundled registry's newest satisfying entry, through
 *   `installPlugin`. A plugin with a live row is skipped before any fetch,
 *   so the second boot reads nothing and writes nothing. Unsetting the
 *   variable uninstalls nothing.
 * - `SPACES_CREDENTIAL_<ID>` (the plugin id upper-cased, `-` as `_`) seeds
 *   the workspace credential `provider = <id>` only when none exists, in the
 *   row shape the Integrations page writes. A key changed on the page
 *   survives every reboot.
 * - Neither is required; with both unset this reads nothing and says nothing.
 * - Never fatal: a plugin that cannot be installed is one warning line.
 * - This is the one module here that reads the environment (`process.env`
 *   is only the default of `options.env`).
 */

export const PLUGINS_VAR = 'SPACES_PLUGINS'
const CREDENTIAL_PREFIX = 'SPACES_CREDENTIAL_'

/** Same rule as the manifest's id; underscores never appear, so `_` → `-` is exact. */
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export type FirstBootEnv = { readonly [name: string]: string | undefined }

export type FirstBootOptions = {
  readonly env?: FirstBootEnv
  /** Defaults to the bundled `registry.json`. */
  readonly registryFile?: string
  /** Defaults to `fetchPluginTarball` (`https:` or `file:`). */
  readonly fetchTarball?: (url: string) => Promise<Uint8Array>
  /** Defaults to the image's `plugin-keys/`. */
  readonly keysDir?: string
  /** Defaults to `dataDir()`. */
  readonly dataDir?: string
}

export type FirstBootResult = {
  /** `<id>@<version>` for each plugin this boot installed. */
  readonly installed: ReadonlyArray<string>
  /** Plugin ids whose workspace key this boot seeded. */
  readonly seeded: ReadonlyArray<string>
}

/** The env var that seeds a plugin's key: `rss-feeds` → `SPACES_CREDENTIAL_RSS_FEEDS`. */
export const credentialVariable = (pluginId: string): string =>
  `${CREDENTIAL_PREFIX}${pluginId.toUpperCase().replaceAll('-', '_')}`

/** `apollo, rss` → the ids, and the tokens that are not plugin ids. */
export const namedPlugins = (
  value: string | undefined,
): { readonly ids: Array<string>; readonly invalid: Array<string> } => {
  const tokens = (value ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
  return {
    ids: [...new Set(tokens.filter((t) => PLUGIN_ID.test(t)))],
    invalid: tokens.filter((t) => !PLUGIN_ID.test(t)),
  }
}

export type SeedCredential = {
  readonly variable: string
  readonly pluginId: string
  readonly secret: string
}

/** Every non-empty `SPACES_CREDENTIAL_<ID>`, with the plugin id it names. */
export const credentialSeeds = (env: FirstBootEnv): Array<SeedCredential> =>
  Object.entries(env).flatMap(([variable, raw]) => {
    if (!variable.startsWith(CREDENTIAL_PREFIX)) return []
    const secret = raw?.trim() ?? ''
    if (secret === '') return []
    const pluginId = variable
      .slice(CREDENTIAL_PREFIX.length)
      .toLowerCase()
      .replaceAll('_', '-')
    return [{ variable, pluginId, secret }]
  })

/** The newest entry for `pluginId` this core and SDK can load (`runsOn`). */
export const newestSatisfying = (
  entries: ReadonlyArray<RegistryEntry>,
  pluginId: string,
): RegistryEntry | undefined =>
  newestPerPlugin(entries.filter((e) => e.id === pluginId)).at(0)

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const query = <T>(label: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new Error(`${label}: ${reasonOf(cause)}`),
  })

const liveRows = (ids: ReadonlyArray<string>) =>
  query('reading the installed plugins', () =>
    db
      .select({
        id: integration.id,
        capabilityId: integration.capabilityId,
        manifest: integration.manifest,
      })
      .from(integration)
      .where(
        and(
          isNull(integration.removedAt),
          inArray(integration.capabilityId, [...ids]),
        ),
      ),
  )

/** Install each named plugin that has no live row. */
const installNamed = Effect.fn('installNamed')(function* (
  ids: ReadonlyArray<string>,
  options: FirstBootOptions,
) {
  const installed: Array<string> = []
  if (ids.length === 0) return installed
  const live = new Set((yield* liveRows(ids)).map((r) => r.capabilityId))
  const missing = ids.filter((id) => !live.has(id))
  if (missing.length === 0) return installed

  const entries = yield* readRegistryFile(options.registryFile).pipe(
    Effect.result,
  )
  if (entries._tag === 'Failure') {
    yield* Effect.logWarning(
      `[plugins] ${PLUGINS_VAR}: ${entries.failure.message}; installed nothing`,
    )
    return installed
  }
  const trust = yield* loadPluginTrust({
    ...(options.keysDir === undefined ? {} : { keysDir: options.keysDir }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
  })
  const fetchTarball = options.fetchTarball ?? fetchPluginTarball

  for (const id of missing) {
    const entry = newestSatisfying(entries.success, id)
    if (entry === undefined) {
      yield* Effect.logWarning(
        `[plugins] ${PLUGINS_VAR}: no version of ${id} in the registry runs on this core`,
      )
      continue
    }
    const tarball = yield* query(`fetching ${entry.tarball}`, () =>
      fetchTarball(entry.tarball),
    ).pipe(Effect.result)
    if (tarball._tag === 'Failure') {
      yield* Effect.logWarning(
        `[plugins] ${PLUGINS_VAR}: could not install ${id} ${entry.version} — ${tarball.failure.message}`,
      )
      continue
    }
    const done = yield* installPlugin(
      { tarball: tarball.success, entry, trust, actorId: null },
      options.dataDir === undefined ? {} : { dataDir: options.dataDir },
    ).pipe(Effect.result)
    if (done._tag === 'Failure') {
      const e = done.failure
      yield* Effect.logWarning(
        `[plugins] ${PLUGINS_VAR}: ${id} not installed — ${e._tag === 'PluginRefused' ? `refused (${e.code}): ${e.reason}` : e.message}`,
      )
      continue
    }
    installed.push(`${id}@${entry.version}`)
    yield* Effect.logInfo(
      `[plugins] ${PLUGINS_VAR}: installed ${id} ${entry.version}${done.success.warning === null ? '' : ` (${done.success.warning})`}`,
    )
  }
  return installed
})

/** The first admin, whom a seeded key is recorded as created by. */
const firstAdmin = query('reading the first admin', async () =>
  (
    await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.role, 'admin'))
      .orderBy(asc(user.createdAt))
      .limit(1)
  ).at(0),
)

/** Seed one plugin's workspace key, unless the vault already holds one. */
const seedOne = Effect.fn('seedOne')(function* (seed: SeedCredential) {
  const { variable, pluginId, secret } = seed
  const skip = (why: string) =>
    Effect.logWarning(`[plugins] ${variable}: ${why}; nothing seeded`).pipe(
      Effect.as(false),
    )
  if (!PLUGIN_ID.test(pluginId)) return yield* skip('not a plugin id')
  if (
    (yield* query('reading the vault', () =>
      readWorkspaceCredential(pluginId),
    )) !== undefined
  )
    return false
  const row = (yield* liveRows([pluginId])).at(0)
  if (row === undefined) return yield* skip(`${pluginId} is not installed`)
  const manifest = manifestSchema.safeParse(row.manifest)
  const kind = manifest.success
    ? manifest.data.requires?.credential?.kind
    : undefined
  if (kind === undefined) return yield* skip(`${pluginId} takes no key`)
  const admin = yield* firstAdmin
  if (admin === undefined)
    return yield* skip(
      'no admin exists yet; it is seeded on the first boot after setup',
    )
  const display = redact(secret)
  const stored = yield* query('storing the key', () =>
    storeCredential({
      scope: 'workspace',
      provider: pluginId,
      kind,
      secret,
      meta: { display, slot: 'credential' },
      createdBy: admin.id,
    }),
  )
  yield* query('binding the key', () =>
    db
      .update(integration)
      .set({ credentialId: stored.id })
      .where(eq(integration.id, row.id)),
  )
  yield* query('telling the worker', () =>
    db.execute(sql`select pg_notify(${PLUGIN_CHANGED}, ${pluginId})`),
  )
  yield* Effect.logInfo(
    `[plugins] ${variable}: seeded ${pluginId}'s key (${display})`,
  )
  return true
})

/**
 * Run both conveniences, plugins first so a key named for a plugin being
 * installed has its row to bind to. Every failure is a logged line; the
 * boot continues.
 */
export const firstBootPlugins = Effect.fn('firstBootPlugins')(function* (
  options: FirstBootOptions = {},
): Effect.fn.Return<FirstBootResult> {
  const env = options.env ?? process.env
  const named = namedPlugins(env[PLUGINS_VAR])
  for (const token of named.invalid)
    yield* Effect.logWarning(
      `[plugins] ${PLUGINS_VAR}: '${token}' is not a plugin id; skipped`,
    )
  const installed = yield* installNamed(named.ids, options).pipe(
    Effect.catch((e: Error) =>
      Effect.logWarning(`[plugins] ${PLUGINS_VAR}: ${e.message}`).pipe(
        Effect.as([]),
      ),
    ),
  )
  const seeded: Array<string> = []
  for (const seed of credentialSeeds(env)) {
    const done = yield* seedOne(seed).pipe(
      Effect.catch((e: Error) =>
        Effect.logWarning(`[plugins] ${seed.variable}: ${e.message}`).pipe(
          Effect.as(false),
        ),
      ),
    )
    if (done) seeded.push(seed.pluginId)
  }
  return { installed, seeded }
})
