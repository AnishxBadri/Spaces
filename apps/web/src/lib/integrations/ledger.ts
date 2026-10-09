import { Clock, Effect, Schema } from 'effect'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notLike,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  credential,
  enrichmentRecord,
  entity,
  integration,
  jobRun,
  space,
} from '@spaces/db/schema'
import type { credentialKind } from '@spaces/db/schema'
import {
  LEGACY_KEY,
  autoEnrichScopeOf,
  scopeWords,
} from '@spaces/core/plugins/auto-enrich'
import type { AutoEnrichScopeName } from '@spaces/core/plugins/auto-enrich'
import { updateFor } from '@spaces/core/plugins/registry'
import { webhookSecretProvider } from '@spaces/core/writes/ingress/receive'
import { MISSING_SETTINGS } from '@spaces/core/writes/ports/config'
import { manifestSchema, satisfiesSdk } from '@spaces/sdk'
import type { Manifest } from '@spaces/sdk'
import { describeExternalOrigin } from '#/lib/server/external-origin'
import { registryEntriesProgram } from './registry'
import type { RegistrySource } from './registry'
import { formValuesOf, settingsFormOf } from './settings-form'
import type { FormValues, SettingsForm } from './settings-form'

/**
 * Settings → Integrations, the read half: every installed plugin row with
 * its version, state, last run, last error and today's credits, and one
 * row's settings form and key fields.
 * - Rendered from the row and its stored manifest alone: web never reads
 *   the plugins directory and never loads a bundle.
 * - Never a first-party `core.*` row, which is a channel, not a plugin, and
 *   never an uninstalled one (`removed_at`): those rows stay only so what
 *   the plugin wrote still names it.
 */

export class IntegrationReadFailed extends Schema.TaggedError<IntegrationReadFailed>()(
  'IntegrationReadFailed',
  { cause: Schema.Defect() },
) {}

export class IntegrationNotFound extends Schema.TaggedError<IntegrationNotFound>()(
  'IntegrationNotFound',
  { message: Schema.String },
) {}

/**
 * How a row reads, one word per way of (not) running:
 * - `off`: the operator's switch (`enabled = false`).
 * - `tripped`: the worker's breaker (`enabled`, status `disabled`); reset clears it.
 * - `needs-key`: the manifest requires a key the row does not have — not yet, not an error.
 * - `needs-setup`: a required setting has no value yet (`missing settings`) — not yet, too.
 * - `degraded`: the worker could not load it, with the reason.
 * - `starting`: installed, not yet looked at by the worker.
 */
export type IntegrationState =
  | 'enabled'
  | 'starting'
  | 'needs-key'
  | 'needs-setup'
  | 'degraded'
  | 'tripped'
  | 'off'

export type IntegrationRow = {
  readonly id: string
  readonly pluginId: string
  readonly name: string
  readonly version: string
  readonly enabled: boolean
  readonly state: IntegrationState
  /** `last_error`: the degraded or tripped reason. */
  readonly reason: string | null
  /** The latest run's one line, else the manifest's description. */
  readonly summary: string | null
  /** The latest run, by `started_at`; `ago` is computed on the server. */
  readonly lastRun: { readonly ago: string; readonly failed: boolean } | null
  /** Credits spent since UTC midnight, against the cap when one is set. */
  readonly credits: { readonly used: number; readonly cap: number | null }
  /** The auto-enrich scope in words (`deal · space`, `off`); null with no event job. */
  readonly autoEnrich: string | null
  /** Runs failed in a row, as the breaker counts them. */
  readonly errorCount: number
  /** The newest satisfying registry version past this one: the badge and Update's target. */
  readonly update: string | null
  /** Why the registry's newest version is not offered: `2.0.0 needs sdk ^2.0; this host provides 1.1.0`. */
  readonly held: string | null
  /** The last upgrade and whether going back is a swap or a restore; null when never upgraded. */
  readonly rollback: Rollback | null
}

/**
 * The rollback answer, read from the row's upgrade record, never guessed:
 * - `available`: no migration ran since the upgrade; the previous
 *   directory, kept one back, can be swapped back;
 * - `unsafe`: one did, and the previous version cannot read its schema —
 *   restore from backup;
 * - `unknown`: the worker has not loaded the new version yet.
 */
export type Rollback = {
  readonly from: string
  readonly answer: 'available' | 'unsafe' | 'unknown'
}

export const rollbackOf = (
  row: Pick<Row, 'upgradedFrom' | 'upgradeMigrated'>,
): Rollback | null => {
  if (row.upgradedFrom === null) return null
  return {
    from: row.upgradedFrom,
    answer:
      row.upgradeMigrated === null
        ? 'unknown'
        : row.upgradeMigrated
          ? 'unsafe'
          : 'available',
  }
}

/** A vault secret a manifest can ask for, each bound to its own `integration` column. */
export type SecretSlot = 'credential' | 'webhook'

type Row = typeof integration.$inferSelect
type CredentialKind = (typeof credentialKind.enumValues)[number]

/**
 * Where each slot lives: the kind and provider it is stored under in the
 * vault and the column that binds it. A third secret is one more entry.
 * - `required`: the loader degrades a row without it ('missing credential').
 */
export const SECRET_SLOTS: {
  readonly [S in SecretSlot]: {
    readonly kindOf: (manifest: Manifest) => CredentialKind | undefined
    readonly provider: (pluginId: string) => string
    readonly held: (row: Row) => string | null
    readonly bind: (
      credentialId: string | null,
    ) => Pick<Partial<Row>, 'credentialId' | 'webhookCredentialId'>
    readonly label: (name: string) => string
    readonly required: boolean
  }
} = {
  credential: {
    kindOf: (m) => m.requires?.credential?.kind,
    provider: (pluginId) => pluginId,
    held: (row) => row.credentialId,
    bind: (credentialId) => ({ credentialId }),
    label: (name) => `${name} key`,
    required: true,
  },
  webhook: {
    kindOf: (m) =>
      m.ingress?.signature === 'hmac-sha256' ? 'webhook' : undefined,
    provider: webhookSecretProvider,
    held: (row) => row.webhookCredentialId,
    bind: (webhookCredentialId) => ({ webhookCredentialId }),
    label: (name) => `${name} webhook secret`,
    required: false,
  },
}

const SLOT_ORDER: ReadonlyArray<SecretSlot> = ['credential', 'webhook']

/** One vault secret the manifest asks for. One entry per slot, so a second secret is one more entry. */
export type SecretField = {
  readonly slot: SecretSlot
  readonly label: string
  /** The redacted display stored at save time; null when nothing is saved. */
  readonly display: string | null
}

/** A space the auto-enrich scope can name, labelled by its path of names. */
export type SpaceOption = { readonly id: string; readonly label: string }

/** The auto-enrich form: the row's scope and every space it could choose. */
export type AutoEnrichView = {
  readonly scopes: ReadonlyArray<AutoEnrichScopeName>
  readonly spaces: ReadonlyArray<string>
  readonly options: ReadonlyArray<SpaceOption>
}

export type IntegrationDetail = IntegrationRow & {
  readonly description: string | null
  /** For a degraded row whose sdk range this host cannot meet: what would fix it. */
  readonly fix: string | null
  readonly form: SettingsForm
  /** The form's starting values, from `integration.config`. */
  readonly values: FormValues
  readonly secrets: ReadonlyArray<SecretField>
  /** Where a provider posts deliveries, when the manifest declares ingress. */
  readonly webhookUrl: string | null
  /** The auto-enrich scope form; null for a plugin with no event job. */
  readonly autoEnrichForm: AutoEnrichView | null
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new IntegrationReadFailed({ cause }),
  })

/** The stored manifest, or null when the worker has not validated one. */
export const manifestOf = (stored: unknown): Manifest | null => {
  const parsed = manifestSchema.safeParse(stored)
  return parsed.success ? parsed.data : null
}

export const stateOf = (
  row: Row,
  manifest: Manifest | null,
): IntegrationState => {
  if (!row.enabled) return 'off'
  if (row.status === 'disabled') return 'tripped'
  if (manifest?.requires?.credential !== undefined && row.credentialId === null)
    return 'needs-key'
  if (row.status === 'degraded' && row.lastError === MISSING_SETTINGS)
    return 'needs-setup'
  if (row.status === 'degraded') return 'degraded'
  if (row.status === 'installing') return 'starting'
  return 'enabled'
}

/** `4m ago`, `2h ago`, `3d ago` — from milliseconds elapsed. */
export const agoOf = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const nonNegative = z.number().nonnegative()
const declaredDefaults = z.object({
  properties: z.record(z.string(), z.object({ default: z.unknown() }).loose()),
})

/** `dailyCreditCap` from the row's config, else the manifest's default, else none. */
const capOf = (
  config: { readonly [key: string]: unknown },
  manifest: Manifest | null,
): number | null => {
  const configured = nonNegative.safeParse(config['dailyCreditCap'])
  if (configured.success) return configured.data
  const declared = declaredDefaults.safeParse(manifest?.settings)
  if (!declared.success) return null
  const properties = declared.data.properties
  const fallback = nonNegative.safeParse(
    Object.hasOwn(properties, 'dailyCreditCap')
      ? properties['dailyCreditCap'].default
      : undefined,
  )
  return fallback.success ? fallback.data : null
}

/** `<APP_URL>/api/webhooks/<integration id>`: the row id, never the plugin id. */
export const webhookUrlOf = (
  manifest: Manifest | null,
  id: string,
): string | null =>
  manifest?.ingress === undefined
    ? null
    : `${describeExternalOrigin(process.env.APP_URL).origin}/api/webhooks/${id}`

/** Whether a plugin declares an event job — what an auto-enrich scope gates. */
export const hasEventJob = (manifest: Manifest | null): boolean =>
  manifest !== null &&
  Object.values(manifest.jobs).some((job) => job.trigger === 'event')

/** Every live space, labelled `Fintech / Payments`, in path order. */
const spaceOptions = query(async () => {
  const rows = await db
    .select({
      id: space.entityId,
      path: space.path,
      name: entity.canonicalName,
    })
    .from(space)
    .innerJoin(entity, eq(entity.id, space.entityId))
    .where(isNull(entity.mergedIntoId))
    .orderBy(asc(space.path))
  const names = new Map(rows.map((r) => [r.path, r.name]))
  return rows.map((r) => {
    const parts = r.path.split('.')
    return {
      id: r.id,
      label: parts
        .map((_, i) => names.get(parts.slice(0, i + 1).join('.')) ?? parts[i])
        .join(' / '),
    }
  })
})

const fixOf = (row: Row, manifest: Manifest | null): string | null => {
  if (manifest === null || row.status !== 'degraded') return null
  const sdk = satisfiesSdk(manifest.sdk)
  return sdk.ok
    ? null
    : `Install a version of ${manifest.name} built for this host's sdk, or update Spaces to one that meets ${manifest.sdk}.`
}

/** A plugin's latest `job_run`, as the ledger reads it. */
export type LatestRun = {
  readonly startedAt: Date
  readonly status: (typeof jobRun.$inferSelect)['status']
  readonly summary: string | null
}

/**
 * The last-run lane and the run's one line: the later of the latest run's
 * start and the row's `last_run_at`, failed only when that run failed.
 */
export const latestRunOf = (
  run: LatestRun | undefined,
  lastRunAt: Date | null,
  now: number,
): {
  readonly lastRun: IntegrationRow['lastRun']
  readonly summary: string | null
} => {
  const lastAt = [run?.startedAt, lastRunAt]
    .filter((d): d is Date => d instanceof Date)
    .reduce<Date | null>((a, b) => (a === null || b > a ? b : a), null)
  return {
    summary: run?.summary ?? null,
    lastRun:
      lastAt === null
        ? null
        : {
            ago: agoOf(now - lastAt.getTime()),
            failed: run?.status === 'failed',
          },
  }
}

const utcMidnight = sql`(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`

const displaySchema = z.object({ display: z.string() })

/** Rows, latest runs and today's spend for the given integrations, read together. */
const readRows = Effect.fn('readRows')(function* (
  rows: ReadonlyArray<Row>,
  source: RegistrySource,
): Effect.fn.Return<
  Array<{ row: Row; manifest: Manifest | null; view: IntegrationRow }>,
  IntegrationReadFailed
> {
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return []
  const runs = yield* query(() =>
    db
      .selectDistinctOn([jobRun.integrationId], {
        integrationId: jobRun.integrationId,
        startedAt: jobRun.startedAt,
        status: jobRun.status,
        summary: jobRun.summary,
      })
      .from(jobRun)
      .where(inArray(jobRun.integrationId, ids))
      .orderBy(jobRun.integrationId, desc(jobRun.startedAt)),
  )
  const spend = yield* query(() =>
    db
      .select({
        integrationId: enrichmentRecord.integrationId,
        used: sql`coalesce(sum(${enrichmentRecord.creditsUsed}), 0)`.mapWith(
          Number,
        ),
      })
      .from(enrichmentRecord)
      .where(
        and(
          inArray(enrichmentRecord.integrationId, ids),
          gte(enrichmentRecord.fetchedAt, utcMidnight),
        ),
      )
      .groupBy(enrichmentRecord.integrationId),
  )
  const entries = yield* registryEntriesProgram(source)
  const now = yield* Clock.currentTimeMillis
  return rows.map((row) => {
    const manifest = manifestOf(row.manifest)
    const latest = latestRunOf(
      runs.find((r) => r.integrationId === row.id),
      row.lastRunAt,
      now,
    )
    const name = manifest?.name ?? row.capabilityId
    const offer = updateFor(entries, row.capabilityId, row.version)
    return {
      row,
      manifest,
      view: {
        id: row.id,
        pluginId: row.capabilityId,
        name,
        version: row.version,
        enabled: row.enabled,
        state: stateOf(row, manifest),
        reason: row.lastError,
        summary: latest.summary ?? manifest?.description ?? null,
        lastRun: latest.lastRun,
        credits: {
          used: spend.find((s) => s.integrationId === row.id)?.used ?? 0,
          cap: capOf(row.config, manifest),
        },
        autoEnrich: hasEventJob(manifest)
          ? scopeWords(autoEnrichScopeOf(row.config))
          : null,
        errorCount: row.errorCount,
        update: offer.target?.version ?? null,
        held: offer.target === null ? (offer.held?.reason ?? null) : null,
        rollback: rollbackOf(row),
      },
    }
  })
})

const plugins = and(
  notLike(integration.capabilityId, 'core.%'),
  isNull(integration.removedAt),
)

/** Every installed plugin, by id. */
export const integrationLedgerProgram = Effect.fn('integrationLedgerProgram')(
  function* (
    source: RegistrySource = {},
  ): Effect.fn.Return<Array<IntegrationRow>, IntegrationReadFailed> {
    const rows = yield* query(() =>
      db
        .select()
        .from(integration)
        .where(plugins)
        .orderBy(asc(integration.capabilityId), asc(integration.createdAt)),
    )
    return (yield* readRows(rows, source)).map((r) => r.view)
  },
)

/** How many plugins are installed, for the settings nav. */
export const integrationCountProgram = Effect.fn('integrationCountProgram')(
  function* (): Effect.fn.Return<number, IntegrationReadFailed> {
    const rows = yield* query(() =>
      db.select({ n: count() }).from(integration).where(plugins),
    )
    return rows.at(0)?.n ?? 0
  },
)

/** One plugin's row, its settings form prefilled from `config`, and its key fields. */
export const integrationDetailProgram = Effect.fn('integrationDetailProgram')(
  function* (
    id: string,
    source: RegistrySource = {},
  ): Effect.fn.Return<
    IntegrationDetail,
    IntegrationReadFailed | IntegrationNotFound
  > {
    const found = (yield* query(() =>
      db
        .select()
        .from(integration)
        .where(and(eq(integration.id, id), plugins)),
    )).at(0)
    if (!found)
      return yield* new IntegrationNotFound({
        message: 'That integration is not installed',
      })
    const read = (yield* readRows([found], source)).at(0)
    if (!read)
      return yield* new IntegrationNotFound({
        message: 'That integration is not installed',
      })
    const { row, manifest, view } = read
    const secrets: Array<SecretField> = []
    for (const slot of SLOT_ORDER) {
      const spec = SECRET_SLOTS[slot]
      if (manifest === null || spec.kindOf(manifest) === undefined) continue
      const held = spec.held(row)
      const stored =
        held === null
          ? undefined
          : (yield* query(() =>
              db
                .select({ meta: credential.meta })
                .from(credential)
                .where(eq(credential.id, held)),
            )).at(0)
      const display = displaySchema.safeParse(stored?.meta)
      secrets.push({
        slot,
        label: spec.label(view.name),
        display:
          held === null
            ? null
            : display.success
              ? display.data.display
              : '••••',
      })
    }
    const drawn: SettingsForm =
      manifest === null
        ? {
            ok: false,
            reason:
              'the worker has not read this plugin’s manifest yet, so its settings cannot be drawn',
          }
        : settingsFormOf(manifest.settings)
    const scoped = hasEventJob(manifest)
    // An older bundle's on/off switch is the scope's now: not drawn twice.
    const form: SettingsForm =
      drawn.ok && scoped
        ? { ok: true, fields: drawn.fields.filter((f) => f.key !== LEGACY_KEY) }
        : drawn
    const scope = autoEnrichScopeOf(row.config)
    return {
      ...view,
      description: manifest?.description ?? null,
      fix: fixOf(row, manifest),
      form,
      values: form.ok ? formValuesOf(form.fields, row.config) : {},
      secrets,
      webhookUrl: webhookUrlOf(manifest, row.id),
      autoEnrichForm: scoped
        ? {
            scopes: scope.scopes,
            spaces: scope.spaces,
            options: yield* spaceOptions,
          }
        : null,
    }
  },
)
