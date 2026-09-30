import { existsSync, readFileSync } from 'node:fs'
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
import { dataDir } from '@spaces/core/writes/vault/key'
import { SDK_VERSION, manifestSchema, satisfiesSdk } from '@spaces/sdk'
import type { Manifest } from '@spaces/sdk'
import { resolvePluginImportsToHost } from './host-resolve'

/**
 * Loader part one (sdk-11; docs/spec-plugin-sdk.md §7 steps 1–4 and 8, §10
 * "boot reconciliation"): the half of the loader that decides whether a
 * plugin may run at all. Every worker boot, before any queue registers:
 *
 *   1. discover  enabled `integration` rows — never a `core.*` row, which
 *                is a first-party channel (the mailbox), not a plugin
 *   2. locate    `<plugins>/<id>/current/{manifest.json,bundle.mjs}`
 *   3. validate  manifest.json parses under the SDK's `manifestSchema` and
 *                names the row's capability; `manifest.sdk` is satisfied
 *                by this host; the bundle's sha256 matches its lock.json
 *                entry (no entry → loads, recorded unpinned); what the
 *                manifest `requires` is on the row
 *   4. import    `bundle.mjs`, its three bare imports resolved to the
 *                host's copies (`./host-resolve.ts`)
 *   8. mark      `integration.status` enabled | degraded, the reason in
 *                `last_error`, and the parsed manifest in
 *                `integration.manifest` — which web renders from, so web
 *                never reads `/data` and never runs plugin code
 *
 * Steps 5–7 (plugin migrations, the per-job Layer, queues) are sdk-12a/12b;
 * nothing is registered here. Every failure is one plugin `degraded` with a
 * reason, and the loop moves on — a plugin never stops the box. Rows are the
 * intent (§10's three sources of truth): files with no row are ignored, and
 * a row with no files is degraded naming the path it expected.
 *
 * Idempotent: a row is written only when its status, reason or manifest
 * would change, so a second boot against the same files and rows writes
 * nothing.
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
  readonly status: 'enabled' | 'degraded'
  readonly reason: string | null
  /** True when lock.json pins the bundle; null when the check was not reached. */
  readonly pinned: boolean | null
  readonly line: string
}

/** A plugin that passed every step: what sdk-12b wires and registers. */
export type LoadedPlugin = {
  readonly integrationId: string
  readonly manifest: Manifest
  readonly jobs: { readonly [name: string]: unknown }
}

export type Reconciled = {
  readonly verdicts: ReadonlyArray<Verdict>
  readonly loaded: ReadonlyArray<LoadedPlugin>
}

export type ReconcileOptions = {
  /** Defaults to `<dataDir()>/plugins`. */
  readonly pluginsRoot?: string
}

export const pluginsRootDir = (): string => path.join(dataDir(), 'plugins')

const truncate = (text: string): string =>
  text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The stored manifest is JSON — `integration.manifest`'s column type. */
const jsonRecord = z.record(z.string(), z.json())

/** What a bundle's default export must look like to be loaded at all. */
const pluginExport = z.object({
  default: z.object({
    manifest: z.object({ id: z.string() }),
    jobs: z.record(z.string(), z.unknown()),
  }),
})

type Row = typeof integration.$inferSelect

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
  readonly manifest: Manifest
  readonly stored: IntegrationManifest
  readonly jobs: { readonly [name: string]: unknown }
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
    const dir = path.join(pluginsRoot, id, 'current')
    const manifestFile = path.join(dir, 'manifest.json')
    const bundleFile = path.join(dir, 'bundle.mjs')

    // 2. locate
    for (const file of [manifestFile, bundleFile]) {
      if (!existsSync(file)) {
        return yield* new Degraded({ reason: `plugin file missing: ${file}` })
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
    if (entry !== undefined && entry.sha256 !== bundleSha256(bytes)) {
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

    // 4. import
    resolvePluginImportsToHost(pluginsRoot)
    const mod: unknown = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ pathToFileURL(bundleFile).href),
      catch: (error) =>
        new Degraded({
          reason: truncate(`bundle.mjs failed to import: ${messageOf(error)}`),
        }),
    })
    const exported = pluginExport.safeParse(mod)
    if (!exported.success) {
      return yield* new Degraded({
        reason:
          'bundle.mjs has no definePlugin(…) default export with manifest and jobs',
      })
    }
    const jobs = exported.data.default.jobs
    const declared = Object.keys(manifest.jobs).sort()
    if (!isDeepStrictEqual(Object.keys(jobs).sort(), declared)) {
      return yield* new Degraded({
        reason: `bundle.mjs exports jobs [${Object.keys(jobs).sort().join(', ')}], manifest.json declares [${declared.join(', ')}]`,
      })
    }

    return {
      manifest,
      stored,
      jobs,
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
        ),
      )
      .orderBy(integration.capabilityId, integration.createdAt),
  )
  const lock = readLock(pluginsRoot)

  const verdicts: Array<Verdict> = []
  const loaded: Array<LoadedPlugin> = []
  for (const row of rows) {
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
      loaded.push({
        integrationId: row.id,
        manifest: ok.manifest,
        jobs: ok.jobs,
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
