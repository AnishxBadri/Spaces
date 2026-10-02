import { Effect, Schema } from 'effect'
import { and, asc, eq, notLike } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, integration } from '@spaces/db/schema'
import { manifestSchema } from '@spaces/sdk'
import type { ACTION_TARGETS } from '@spaces/sdk'
import { pluginQueueName } from '@spaces/core/queue/names'
import type { PluginQueueName } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'
import { requireUser } from '#/lib/server/shared'

/**
 * Manifest actions in the record head. (D63)
 * - Read from `integration.manifest` alone: web never loads a bundle or
 *   reads the plugins directory.
 * - Runnable means `enabled` and status `enabled`; a degraded,
 *   operator-disabled or breaker-tripped row offers nothing, and Today and
 *   Review say why.
 * - Any member may fire one; settings and keys stay admin.
 */

/** The record kinds a manifest action may be declared `on`. */
export type ActionTarget = (typeof ACTION_TARGETS)[number]

/** One control in a record head. */
export type RecordAction = {
  readonly integrationId: string
  readonly pluginId: string
  readonly pluginName: string
  readonly actionId: string
  readonly label: string
}

export class PluginActionRefused extends Schema.TaggedError<PluginActionRefused>()(
  'PluginActionRefused',
  { message: Schema.String },
) {}

export class PluginActionFailed extends Schema.TaggedError<PluginActionFailed>()(
  'PluginActionFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PluginActionFailed({ cause }),
  })

/** An action as the manifest declares it, with the queue its job runs on. */
type Declared = {
  readonly pluginId: string
  readonly pluginName: string
  readonly actionId: string
  readonly label: string
  readonly on: ActionTarget
  readonly queue: PluginQueueName
}

/**
 * Every action a stored manifest declares; nothing for one that no longer
 * decodes or names a job that is not an action job.
 */
export const declaredActions = (manifest: unknown): ReadonlyArray<Declared> => {
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) return []
  const m = parsed.data
  return (m.actions ?? []).flatMap((action) => {
    const job = Object.hasOwn(m.jobs, action.job) ? m.jobs[action.job] : null
    if (job?.trigger !== 'action') return []
    return [
      {
        pluginId: m.id,
        pluginName: m.name,
        actionId: action.id,
        label: action.label,
        on: action.on,
        queue: pluginQueueName(m.id, action.job, job.interactive === true),
      },
    ]
  })
}

const runnable = and(
  eq(integration.enabled, true),
  eq(integration.status, 'enabled'),
  notLike(integration.capabilityId, 'core.%'),
)

/** The controls a record of `kind` carries, in plugin order. */
export const recordActionsProgram = Effect.fn('recordActionsProgram')(
  function* (
    kind: ActionTarget,
  ): Effect.fn.Return<Array<RecordAction>, PluginActionFailed> {
    const rows = yield* query(() =>
      db
        .select({ id: integration.id, manifest: integration.manifest })
        .from(integration)
        .where(runnable)
        .orderBy(asc(integration.capabilityId), asc(integration.createdAt)),
    )
    return rows.flatMap((row) =>
      declaredActions(row.manifest)
        .filter((a) => a.on === kind)
        .map((a) => ({
          integrationId: row.id,
          pluginId: a.pluginId,
          pluginName: a.pluginName,
          actionId: a.actionId,
          label: a.label,
        })),
    )
  },
)

export type FireActionInput = {
  readonly integrationId: string
  readonly actionId: string
  readonly entityId: string
}

export type ActionFired =
  | { readonly status: 'queued'; readonly queue: PluginQueueName }
  | { readonly status: 'queue-unavailable' }

/**
 * Fire one action: re-read the row and the record, then enqueue
 * `plugin.<id>.<job>` with `{ entityId }` and return. The page may be stale,
 * so a plugin that stopped since it rendered is refused, never queued.
 */
export const fireActionProgram = Effect.fn('fireActionProgram')(function* (
  input: FireActionInput,
): Effect.fn.Return<ActionFired, PluginActionRefused | PluginActionFailed> {
  const row = (yield* query(() =>
    db
      .select({ manifest: integration.manifest })
      .from(integration)
      .where(and(eq(integration.id, input.integrationId), runnable)),
  )).at(0)
  if (!row)
    return yield* new PluginActionRefused({
      message: 'That plugin is not running — Today says why',
    })
  const action = declaredActions(row.manifest).find(
    (a) => a.actionId === input.actionId,
  )
  if (!action)
    return yield* new PluginActionRefused({
      message: 'That plugin no longer offers this action',
    })
  const record = (yield* query(() =>
    db
      .select({ kind: entity.kind, mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, input.entityId)),
  )).at(0)
  if (!record || record.mergedIntoId !== null)
    return yield* new PluginActionRefused({ message: 'That record is gone' })
  if (record.kind !== action.on)
    return yield* new PluginActionRefused({
      message: `${action.label} runs on a ${action.on}, not a ${record.kind}`,
    })
  const jobId = yield* query(() =>
    enqueue(action.queue, { entityId: input.entityId }),
  )
  return jobId === null
    ? { status: 'queue-unavailable' }
    : { status: 'queued', queue: action.queue }
})

/** The server fn's body: any signed-in member, never only an admin. */
export async function fireRecordActionHandler(
  input: FireActionInput,
): Promise<ActionFired> {
  await requireUser()
  try {
    return await Effect.runPromise(fireActionProgram(input))
  } catch (failure) {
    throw new Error(
      failure instanceof PluginActionRefused
        ? failure.message
        : 'Could not start the action',
    )
  }
}
