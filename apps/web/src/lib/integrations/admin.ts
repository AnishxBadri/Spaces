import { Effect, Schema } from 'effect'
import { and, eq, isNull, notLike, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { releaseCredential } from '@spaces/core/writes/plugins/credential'
import { PLUGIN_CHANGED } from '@spaces/core/writes/plugins/install'
import { redact, storeCredential } from '@spaces/core/writes/vault'
import {
  requireAdmin,
  requireSettingsReader,
  requireUser,
} from '#/lib/server/shared'
import { redactIntegrationDetail } from '#/lib/settings-redact'
import { autoEnrichConfig } from '@spaces/core/plugins/auto-enrich'
import type { AutoEnrichScope } from '@spaces/core/plugins/auto-enrich'
import {
  IntegrationNotFound,
  SECRET_SLOTS,
  hasEventJob,
  integrationCountProgram,
  integrationDetailProgram,
  integrationRunsProgram,
  pluginLedgerProgram,
  manifestOf,
} from './ledger'
import type {
  IntegrationDetail,
  IntegrationRow,
  RunLine,
  SecretSlot,
} from './ledger'
import { checkSettings, mergeConfig, settingsFormOf } from './settings-form'
import type { FormValues } from './settings-form'

/**
 * Settings → Integrations, the write half: on/off, breaker reset, settings
 * and the key. Every write opens with `requireAdmin`; the reads are any
 * member's, secrets redacted.
 * - Every write NOTIFYs `plugin_changed` with the plugin id once it has
 *   committed; the worker reloads that one plugin and writes its status.
 * - The key goes into the vault and never comes back: only its redacted
 *   display is stored (on the credential's `meta`) and returned.
 */

export { PLUGIN_CHANGED }

/** The loader's reason for a row whose manifest requires a key it lacks. */
export const MISSING_CREDENTIAL = 'missing credential'

/** ConfigLive's reason for a row lacking a required setting with no default. */
export { MISSING_SETTINGS } from '@spaces/core/writes/ports/config'

export class IntegrationRefused extends Schema.TaggedError<IntegrationRefused>()(
  'IntegrationRefused',
  { message: Schema.String },
) {}

export class IntegrationWriteFailed extends Schema.TaggedError<IntegrationWriteFailed>()(
  'IntegrationWriteFailed',
  { cause: Schema.Defect() },
) {}

type Failure = IntegrationRefused | IntegrationWriteFailed

const write = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new IntegrationWriteFailed({ cause }),
  })

const rowOf = Effect.fn('rowOf')(function* (id: string) {
  const row = (yield* write(() =>
    db
      .select()
      .from(integration)
      .where(
        and(
          eq(integration.id, id),
          notLike(integration.capabilityId, 'core.%'),
          isNull(integration.removedAt),
        ),
      ),
  )).at(0)
  if (!row)
    return yield* new IntegrationRefused({
      message: 'That integration is not installed',
    })
  return row
})

/** Ask the worker to reload one plugin. After the write commits, never inside it. */
const notifyChanged = (pluginId: string) =>
  write(() => db.execute(sql`select pg_notify(${PLUGIN_CHANGED}, ${pluginId})`))

/** The operator's switch. Off unregisters its queues; the key and config are kept. */
export const setIntegrationEnabledProgram = Effect.fn(
  'setIntegrationEnabledProgram',
)(function* (id: string, enabled: boolean): Effect.fn.Return<void, Failure> {
  const row = yield* rowOf(id)
  yield* write(() =>
    db.update(integration).set({ enabled }).where(eq(integration.id, row.id)),
  )
  yield* notifyChanged(row.capabilityId)
})

/** Clear a tripped breaker: zero failures, status back to enabled, reload. */
export const resetIntegrationProgram = Effect.fn('resetIntegrationProgram')(
  function* (id: string): Effect.fn.Return<void, Failure> {
    const row = yield* rowOf(id)
    if (row.status !== 'disabled')
      return yield* new IntegrationRefused({
        message: `${row.capabilityId} is not stopped by the breaker`,
      })
    yield* write(() =>
      db
        .update(integration)
        .set({ status: 'enabled', errorCount: 0, lastError: null })
        .where(
          and(eq(integration.id, row.id), eq(integration.status, 'disabled')),
        ),
    )
    yield* notifyChanged(row.capabilityId)
  },
)

export type SettingsSaved =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: { readonly [key: string]: string } }

/**
 * Check the form against the stored manifest's settings and write
 * `integration.config`. A field that fails comes back by key and nothing is
 * written, so a bad value never reaches the worker to degrade the plugin.
 */
export const saveIntegrationSettingsProgram = Effect.fn(
  'saveIntegrationSettingsProgram',
)(function* (
  id: string,
  input: FormValues,
): Effect.fn.Return<SettingsSaved, Failure> {
  const row = yield* rowOf(id)
  const manifest = manifestOf(row.manifest)
  if (manifest === null)
    return yield* new IntegrationRefused({
      message: `The worker has not read ${row.capabilityId}'s manifest yet`,
    })
  const form = settingsFormOf(manifest.settings)
  if (!form.ok) return yield* new IntegrationRefused({ message: form.reason })
  const checked = checkSettings(form.fields, input)
  if (!checked.ok) return { ok: false, errors: checked.errors }
  yield* write(() =>
    db
      .update(integration)
      .set({ config: mergeConfig(row.config, checked.values) })
      .where(eq(integration.id, row.id)),
  )
  yield* notifyChanged(row.capabilityId)
  return { ok: true }
})

/**
 * Write the auto-enrich scope onto `integration.config`. Refused for a
 * plugin with no event job. The dispatcher reads the row on every event, so
 * nothing reloads.
 */
export const saveIntegrationAutoEnrichProgram = Effect.fn(
  'saveIntegrationAutoEnrichProgram',
)(function* (
  id: string,
  scope: AutoEnrichScope,
): Effect.fn.Return<void, Failure> {
  const row = yield* rowOf(id)
  if (!hasEventJob(manifestOf(row.manifest)))
    return yield* new IntegrationRefused({
      message: `${row.capabilityId} runs on no trigger, so it has no auto-enrich scope`,
    })
  yield* write(() =>
    db
      .update(integration)
      .set({ config: autoEnrichConfig(row.config, scope) })
      .where(eq(integration.id, row.id)),
  )
})

export type { SecretSlot }

/** The vault kind a slot is stored under, or refused when the manifest asks for no such secret. */
const slotKindOf = Effect.fn('slotKindOf')(function* (
  row: typeof integration.$inferSelect,
  slot: SecretSlot,
) {
  const manifest = manifestOf(row.manifest)
  const kind =
    manifest === null ? undefined : SECRET_SLOTS[slot].kindOf(manifest)
  if (kind === undefined)
    return yield* new IntegrationRefused({
      message:
        slot === 'webhook'
          ? `${row.capabilityId} does not take a webhook secret`
          : `${row.capabilityId} does not take a key`,
    })
  return kind
})

/**
 * Store the pasted secret as the workspace credential for this plugin's slot
 * (`SECRET_SLOTS` names its provider) and bind it to the slot's column. The
 * worker's reload is what moves a row from degraded('missing credential') to
 * enabled.
 */
export const saveIntegrationSecretProgram = Effect.fn(
  'saveIntegrationSecretProgram',
)(function* (
  actorId: string,
  id: string,
  slot: SecretSlot,
  secret: string,
): Effect.fn.Return<{ display: string }, Failure> {
  const row = yield* rowOf(id)
  const kind = yield* slotKindOf(row, slot)
  const spec = SECRET_SLOTS[slot]
  const key = secret.trim()
  if (key === '')
    return yield* new IntegrationRefused({ message: 'Paste a key first' })
  const display = redact(key)
  const stored = yield* write(() =>
    storeCredential({
      scope: 'workspace',
      provider: spec.provider(row.capabilityId),
      kind,
      secret: key,
      meta: { display, slot },
      createdBy: actorId,
    }),
  )
  yield* write(() =>
    db
      .update(integration)
      .set(spec.bind(stored.id))
      .where(eq(integration.id, row.id)),
  )
  yield* notifyChanged(row.capabilityId)
  return { display }
})

/**
 * Unbind and delete one slot's secret. Removing a required key reads the row
 * degraded('missing credential') at once — what the loader would write — so
 * its record actions go before the worker's reload; a tripped row keeps its
 * breaker. Removing the webhook secret leaves the row running, and its
 * deliveries refused until a new one is saved.
 */
export const removeIntegrationSecretProgram = Effect.fn(
  'removeIntegrationSecretProgram',
)(function* (id: string, slot: SecretSlot): Effect.fn.Return<void, Failure> {
  const row = yield* rowOf(id)
  yield* slotKindOf(row, slot)
  const spec = SECRET_SLOTS[slot]
  const credentialId = spec.held(row)
  if (credentialId === null)
    return yield* new IntegrationRefused({
      message: `No ${slot} is saved`,
    })
  yield* write(() =>
    db.transaction(async (tx) => {
      await tx
        .update(integration)
        .set(
          !spec.required || row.status === 'disabled'
            ? spec.bind(null)
            : {
                ...spec.bind(null),
                status: 'degraded',
                lastError: MISSING_CREDENTIAL,
              },
        )
        .where(eq(integration.id, row.id))
      await releaseCredential(tx, row.id, credentialId)
    }),
  )
  yield* notifyChanged(row.capabilityId)
})

/** A refusal's own sentence, or a generic one; never a stack or a cause. */
export const run = async <T, TError>(
  program: Effect.Effect<T, TError>,
): Promise<T> => {
  try {
    return await Effect.runPromise(program)
  } catch (failure) {
    throw new Error(
      failure instanceof IntegrationRefused ||
        failure instanceof IntegrationNotFound
        ? failure.message
        : 'Could not reach the integrations',
    )
  }
}

// The reads are any member's, with a plugin's secrets redacted; every
// write below opens with `requireAdmin()`.

export async function listIntegrationsHandler(): Promise<
  Array<IntegrationRow>
> {
  await requireUser()
  return run(pluginLedgerProgram())
}

export async function countIntegrationsHandler(): Promise<number> {
  await requireUser()
  return run(integrationCountProgram())
}

export async function getIntegrationHandler(input: {
  readonly id: string
}): Promise<IntegrationDetail> {
  const { isAdmin } = await requireSettingsReader()
  const detail = await run(integrationDetailProgram(input.id))
  return isAdmin ? detail : redactIntegrationDetail(detail)
}

/** Any member reads a plugin's runs: the log writes nothing and is every member's provenance. */
export async function getIntegrationRunsHandler(input: {
  readonly id: string
}): Promise<{ readonly name: string; readonly runs: Array<RunLine> }> {
  await requireUser()
  return run(integrationRunsProgram(input.id))
}

export async function setIntegrationEnabledHandler(input: {
  readonly id: string
  readonly enabled: boolean
}): Promise<void> {
  await requireAdmin()
  return run(setIntegrationEnabledProgram(input.id, input.enabled))
}

export async function resetIntegrationHandler(input: {
  readonly id: string
}): Promise<void> {
  await requireAdmin()
  return run(resetIntegrationProgram(input.id))
}

export async function saveIntegrationSettingsHandler(input: {
  readonly id: string
  readonly values: FormValues
}): Promise<SettingsSaved> {
  await requireAdmin()
  return run(saveIntegrationSettingsProgram(input.id, input.values))
}

export async function saveIntegrationAutoEnrichHandler(input: {
  readonly id: string
  readonly scope: AutoEnrichScope
}): Promise<void> {
  await requireAdmin()
  return run(saveIntegrationAutoEnrichProgram(input.id, input.scope))
}

export async function saveIntegrationSecretHandler(input: {
  readonly id: string
  readonly slot: SecretSlot
  readonly secret: string
}): Promise<{ display: string }> {
  const actor = await requireAdmin()
  return run(
    saveIntegrationSecretProgram(actor.id, input.id, input.slot, input.secret),
  )
}

export async function removeIntegrationSecretHandler(input: {
  readonly id: string
  readonly slot: SecretSlot
}): Promise<void> {
  await requireAdmin()
  return run(removeIntegrationSecretProgram(input.id, input.slot))
}
