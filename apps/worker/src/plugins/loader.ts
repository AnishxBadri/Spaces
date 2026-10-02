import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Data, Effect } from 'effect'
import { and, eq, notLike } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema/integrations'
import { LOCK_FILE, bundleSha256, lockSchema } from '@spaces/core/plugins/lock'
import type { Lock } from '@spaces/core/plugins/lock'
import type { BoundIntegration } from '@spaces/core/writes/ports/binding'
import { dataDir } from '@spaces/core/writes/vault/key'
import { SDK_VERSION, manifestSchema, satisfiesSdk } from '@spaces/sdk'
import type { Manifest } from '@spaces/sdk'
import { unprovidedPort } from './grant'
import { resolvePluginImportsToHost } from './host-resolve'

/**
 * Boot reconciliation: decides whether each plugin may run at all, before
 * any queue registers. Steps 1–4 and 8 of the loader; step 6 is
 * `makePluginHost`.
 *
 * - Discovers enabled `integration` rows, never a `core.*` row (a
 *   first-party channel, not a plugin). Rows are the intent: files with no
 *   row are ignored, a row with no files is degraded naming the path.
 * - Validates the manifest, the sdk range, the bundle sha against lock.json
 *   (no entry loads unpinned), what `requires` asks of the row, and that
 *   every port a job declares is one this host provides (`UNPROVIDED_PORTS`).
 * - Imports `bundle.mjs` with its bare imports resolved to the host's copies.
 * - Marks `integration.status` with the reason in `last_error` and the
 *   manifest in `integration.manifest`, which web renders from — web never
 *   reads `/data` and never runs plugin code.
 * - Every failure degrades one plugin and the loop moves on; a plugin never
 *   stops the box. Idempotent: a row is written only when something changes.
 * - A tripped row (`enabled`, status `disabled`) is left exactly as it is and
 *   not loaded: only a reset of the row clears the breaker, never a boot.
 * - Runs on boot and on `plugin_changed` (`makePluginReloader`), for every
 *   row or for one plugin's (`only`).
 */

/** How much of a thrown message `last_error` keeps. */
export const REASON_MAX = 500

/** Why a plugin did not load — one sentence, the row's `last_error`. */
class Degraded extends Data.TaggedError('Degraded')<{
  readonly reason: string
}> {}

/** One plugin's outcome, and the line boot prints for it. */
export type Verdict = {
  readonly integrationId: string
  readonly id: string
  readonly status: 'enabled' | 'degraded' | 'disabled'
  readonly reason: string | null
  /** True when lock.json pins the bundle; null when the check was not reached. */
  readonly pinned: boolean | null
  readonly line: string
}

/** A lifecycle hook as the bundle exported it; the host checks what it returns. */
export type LoadedHook = () => unknown

/** A plugin that passed every step: what `makePluginHost` wires. */
export type LoadedPlugin = {
  readonly integrationId: string
  readonly row: BoundIntegration
  readonly manifest: Manifest
  /** The bundle's `manifest.settings`, which ConfigLive validates the row against. */
  readonly settings: z.ZodType
  readonly jobs: { readonly [name: string]: unknown }
  readonly onEnable?: LoadedHook
  readonly onDisable?: LoadedHook
  /** The bundle imported and the row bound; a wired plugin whose fingerprint changed is reloaded. */
  readonly fingerprint: string
}

export type Reconciled = {
  readonly verdicts: ReadonlyArray<Verdict>
  readonly loaded: ReadonlyArray<LoadedPlugin>
}

export type ReconcileOptions = {
  /** Defaults to `<dataDir()>/plugins`. */
  readonly pluginsRoot?: string
  /** One plugin's rows (its `capabilityId`) instead of every enabled row. */
  readonly only?: string
}

export const pluginsRootDir = (): string => path.join(dataDir(), 'plugins')

export const truncate = (text: string): string =>
  text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The stored manifest is JSON — `integration.manifest`'s column type. */
const jsonRecord = z.record(z.string(), z.json())

const hook = z.custom<LoadedHook>((value) => typeof value === 'function')

/**
 * What a bundle's default export must look like to be loaded at all. The
 * bundle's `zod` is the host's (`resolvePluginImportsToHost`), so its
 * settings schema is a ZodType here.
 */
const pluginExport = z.object({
  default: z.object({
    manifest: z.object({
      id: z.string(),
      settings: z.custom<z.ZodType>((value) => value instanceof z.ZodType),
    }),
    jobs: z.record(z.string(), z.unknown()),
    onEnable: hook.optional(),
    onDisable: hook.optional(),
  }),
})

type Row = typeof integration.$inferSelect

/** The real path, or the path as given when it does not resolve (a missing file is reported later). */
const realpathOr = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** lock.json, or why it cannot be read. Absent is not an error: unpinned. */
const readLock = (pluginsRoot: string): Lock | Degraded => {
  const file = path.join(pluginsRoot, LOCK_FILE)
  if (!existsSync(file)) return { plugins: {} }
  try {
    const parsed = lockSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (parsed.success) return parsed.data
    return new Degraded({
      reason: `${file} is invalid: ${parsed.error.issues.at(0)?.message ?? 'unreadable'}`,
    })
  } catch (error) {
    return new Degraded({ reason: truncate(`${file}: ${messageOf(error)}`) })
  }
}

type Checked = {
  readonly bundleUrl: string
  readonly manifest: Manifest
  readonly stored: IntegrationManifest
  readonly settings: z.ZodType
  readonly jobs: { readonly [name: string]: unknown }
  readonly onEnable?: LoadedHook
  readonly onDisable?: LoadedHook
  readonly pinned: boolean
}

/**
 * Steps 2–4 for one row. Fails `Degraded`; on the way, hands the parsed
 * manifest to `onManifest` as soon as it validates, so a plugin degraded by a
 * later step still carries its manifest for web to show.
 */
const check = (
  row: Row,
  pluginsRoot: string,
  lock: Lock | Degraded,
  onManifest: (stored: IntegrationManifest) => void,
) =>
  Effect.gen(function* () {
    const id = row.capabilityId
    // `current` resolved once: every file is read from one version directory,
    // and the import URL names it (see step 4).
    const current = path.join(pluginsRoot, id, 'current')
    const dir = realpathOr(current)
    const manifestFile = path.join(dir, 'manifest.json')
    const bundleFile = path.join(dir, 'bundle.mjs')

    // 2. locate
    for (const file of [manifestFile, bundleFile]) {
      if (!existsSync(file)) {
        return yield* new Degraded({
          reason: `plugin file missing: ${path.join(current, path.basename(file))}`,
        })
      }
    }

    // 3. validate — the manifest
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(readFileSync(manifestFile, 'utf8')),
      catch: (error) =>
        new Degraded({
          reason: truncate(`manifest.json is not JSON: ${messageOf(error)}`),
        }),
    })
    const parsed = manifestSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues.at(0)
      return yield* new Degraded({
        reason: truncate(
          `manifest.json is invalid: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unreadable'}`,
        ),
      })
    }
    const manifest = parsed.data
    if (manifest.id !== id) {
      return yield* new Degraded({
        reason: `manifest.json names plugin ${manifest.id}, not ${id}`,
      })
    }
    const stored = jsonRecord.parse(raw)
    onManifest(stored)

    const sdk = satisfiesSdk(manifest.sdk, SDK_VERSION)
    if (!sdk.ok) return yield* new Degraded({ reason: sdk.reason })

    // 3. validate — every port a job declares is one this host provides
    const unprovided = unprovidedPort(manifest)
    if (unprovided !== null) {
      return yield* new Degraded({
        reason: `job ${unprovided.job} uses ${unprovided.port}, which this host does not provide yet`,
      })
    }

    // 3. validate — the bundle against lock.json
    if (lock instanceof Degraded) return yield* lock
    const bytes = yield* Effect.try({
      try: () => readFileSync(bundleFile),
      catch: (error) =>
        new Degraded({
          reason: truncate(`${bundleFile}: ${messageOf(error)}`),
        }),
    })
    const entry = Object.hasOwn(lock.plugins, id) ? lock.plugins[id] : undefined
    const sha256 = bundleSha256(bytes)
    if (entry !== undefined && entry.sha256 !== sha256) {
      return yield* new Degraded({
        reason: 'bundle sha does not match lock.json',
      })
    }

    // 3. validate — what the manifest requires of the row
    if (manifest.requires?.credential && row.credentialId === null) {
      return yield* new Degraded({ reason: 'missing credential' })
    }
    if (manifest.requires?.connection && row.connectionId === null) {
      return yield* new Degraded({ reason: 'missing connection' })
    }

    // 4. import — `import()` caches by URL for the life of the process, so the
    // URL is the version directory's real path plus the bytes' sha: a swapped
    // `current` or rewritten bundle is a new module, never the cached one.
    resolvePluginImportsToHost(pluginsRoot)
    const bundleUrl = `${pathToFileURL(bundleFile).href}?sha256=${sha256}`
    const mod: unknown = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ bundleUrl),
      catch: (error) =>
        new Degraded({
          reason: truncate(`bundle.mjs failed to import: ${messageOf(error)}`),
        }),
    })
    const exported = pluginExport.safeParse(mod)
    if (!exported.success) {
      return yield* new Degraded({
        reason:
          'bundle.mjs has no definePlugin(…) default export with manifest, settings and jobs',
      })
    }
    const { jobs, onEnable, onDisable } = exported.data.default
    const declared = Object.keys(manifest.jobs).sort()
    if (!isDeepStrictEqual(Object.keys(jobs).sort(), declared)) {
      return yield* new Degraded({
        reason: `bundle.mjs exports jobs [${Object.keys(jobs).sort().join(', ')}], manifest.json declares [${declared.join(', ')}]`,
      })
    }

    return {
      bundleUrl,
      manifest,
      stored,
      settings: exported.data.default.manifest.settings,
      jobs,
      ...(onEnable === undefined ? {} : { onEnable }),
      ...(onDisable === undefined ? {} : { onDisable }),
      pinned: entry !== undefined,
    } satisfies Checked
  })

/** Write the row only when something the loader owns would change. */
const mark = (
  row: Row,
  next: {
    readonly status: 'enabled' | 'degraded'
    readonly lastError: string | null
    readonly manifest: IntegrationManifest | null
  },
) =>
  Effect.gen(function* () {
    const manifest = next.manifest ?? row.manifest
    const unchanged =
      row.status === next.status &&
      row.lastError === next.lastError &&
      isDeepStrictEqual(row.manifest, manifest)
    if (unchanged) return
    yield* Effect.tryPromise(() =>
      db
        .update(integration)
        .set({ status: next.status, lastError: next.lastError, manifest })
        .where(eq(integration.id, row.id)),
    )
  })

/**
 * Boot reconciliation over every enabled plugin row. Fails only if the
 * database cannot be read or written — the caller logs that and boots on.
 */
export const reconcilePlugins = Effect.fn('reconcilePlugins')(function* (
  options: ReconcileOptions = {},
) {
  const pluginsRoot = options.pluginsRoot ?? pluginsRootDir()
  const rows = yield* Effect.tryPromise(() =>
    db
      .select()
      .from(integration)
      .where(
        and(
          eq(integration.enabled, true),
          notLike(integration.capabilityId, 'core.%'),
          options.only === undefined
            ? undefined
            : eq(integration.capabilityId, options.only),
        ),
      )
      .orderBy(integration.capabilityId, integration.createdAt),
  )
  const lock = readLock(pluginsRoot)

  const verdicts: Array<Verdict> = []
  const loaded: Array<LoadedPlugin> = []
  for (const row of rows) {
    if (row.status === 'disabled') {
      verdicts.push({
        integrationId: row.id,
        id: row.capabilityId,
        status: 'disabled',
        reason: row.lastError,
        pinned: null,
        line: `[plugins] ${row.capabilityId}: disabled — ${row.lastError ?? 'tripped'}; reset the row to re-enable it`,
      })
      continue
    }
    let stored: IntegrationManifest | null = null
    const outcome = yield* check(row, pluginsRoot, lock, (m) => {
      stored = m
    }).pipe(Effect.result)
    if (outcome._tag === 'Success') {
      const ok = outcome.success
      yield* mark(row, {
        status: 'enabled',
        lastError: null,
        manifest: ok.stored,
      })
      const bound: BoundIntegration = {
        id: row.id,
        capabilityId: row.capabilityId,
        config: row.config,
        credentialId: row.credentialId,
      }
      loaded.push({
        integrationId: row.id,
        row: bound,
        fingerprint: JSON.stringify({
          bundle: ok.bundleUrl,
          row: bound,
          connectionId: row.connectionId,
        }),
        manifest: ok.manifest,
        settings: ok.settings,
        jobs: ok.jobs,
        ...(ok.onEnable === undefined ? {} : { onEnable: ok.onEnable }),
        ...(ok.onDisable === undefined ? {} : { onDisable: ok.onDisable }),
      })
      verdicts.push({
        integrationId: row.id,
        id: row.capabilityId,
        status: 'enabled',
        reason: null,
        pinned: ok.pinned,
        line: `[plugins] ${row.capabilityId} ${ok.manifest.version}: enabled${ok.pinned ? '' : ' (unpinned: no lock.json entry)'}`,
      })
    } else {
      const reason = outcome.failure.reason
      yield* mark(row, {
        status: 'degraded',
        lastError: reason,
        manifest: stored,
      })
      verdicts.push({
        integrationId: row.id,
        id: row.capabilityId,
        status: 'degraded',
        reason,
        pinned: null,
        line: `[plugins] ${row.capabilityId}: degraded — ${reason}`,
      })
    }
  }
  return { verdicts, loaded } satisfies Reconciled
})
