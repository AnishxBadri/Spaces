import { Effect, Schema } from 'effect'
import { and, eq, isNull, notLike, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { releaseCredential } from '@spaces/core/writes/plugins/credential'
import { PLUGIN_CHANGED } from '@spaces/core/writes/plugins/install'
import { redact, storeCredential } from '@spaces/core/writes/vault'
import { requireAdmin } from '#/lib/server/shared'
import {
  IntegrationNotFound,
  integrationCountProgram,
  integrationDetailProgram,
  integrationLedgerProgram,
  manifestOf,
} from './ledger'
import type { IntegrationDetail, IntegrationRow } from './ledger'
import { checkSettings, mergeConfig, settingsFormOf } from './settings-form'
import type { FormValues } from './settings-form'

/**
 * Settings → Integrations, the write half: on/off, breaker reset, settings
 * and the key. Admin only (`requireAdmin`, first line of every handler).
 * - Every write NOTIFYs `plugin_changed` with the plugin id once it has
 *   committed; the worker reloads that one plugin and writes its status.
 * - The key goes into the vault and never comes back: only its redacted
 *   display is stored (on the credential's `meta`) and returned.
 */

export { PLUGIN_CHANGED }

/** The loader's reason for a row whose manifest requires a key it lacks. */
export const MISSING_CREDENTIAL = 'missing credential'

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

/** A secret slot the manifest's `requires` declares. */
export type SecretSlot = 'credential'

const credentialKindOf = Effect.fn('credentialKindOf')(function* (
  row: typeof integration.$inferSelect,
) {
  const kind = manifestOf(row.manifest)?.requires?.credential?.kind
  if (kind === undefined)
    return yield* new IntegrationRefused({
      message: `${row.capabilityId} does not take a key`,
    })
  return kind
})

/**
 * Store the pasted key as the workspace credential for this plugin
 * (provider = plugin id) and bind it to the row. The worker's reload is what
 * moves the row from degraded('missing credential') to enabled.
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
  const kind = yield* credentialKindOf(row)
  const key = secret.trim()
  if (key === '')
    return yield* new IntegrationRefused({ message: 'Paste a key first' })
  const display = redact(key)
  const stored = yield* write(() =>
    storeCredential({
      scope: 'workspace',
      provider: row.capabilityId,
      kind,
      secret: key,
      meta: { display, slot },
      createdBy: actorId,
    }),
  )
  yield* write(() =>
    db
      .update(integration)
      .set({ credentialId: stored.id })
      .where(eq(integration.id, row.id)),
  )
  yield* notifyChanged(row.capabilityId)
  return { display }
})

/**
 * Unbind and delete the plugin's key. The row reads degraded('missing
 * credential') at once — what the loader would write — so its record actions
 * go before the worker's reload; a tripped row keeps its breaker.
 */
export const removeIntegrationSecretProgram = Effect.fn(
  'removeIntegrationSecretProgram',
)(function* (id: string, slot: SecretSlot): Effect.fn.Return<void, Failure> {
  const row = yield* rowOf(id)
  yield* credentialKindOf(row)
  const credentialId = row.credentialId
  if (credentialId === null)
    return yield* new IntegrationRefused({
      message: `No ${slot} is saved`,
    })
  yield* write(() =>
    db.transaction(async (tx) => {
      await tx
        .update(integration)
        .set(
          row.status === 'disabled'
            ? { credentialId: null }
            : {
                credentialId: null,
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

export async function listIntegrationsHandler(): Promise<
  Array<IntegrationRow>
> {
  await requireAdmin()
  return run(integrationLedgerProgram())
}

export async function countIntegrationsHandler(): Promise<number> {
  await requireAdmin()
  return run(integrationCountProgram())
}

export async function getIntegrationHandler(input: {
  readonly id: string
}): Promise<IntegrationDetail> {
  await requireAdmin()
  return run(integrationDetailProgram(input.id))
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
