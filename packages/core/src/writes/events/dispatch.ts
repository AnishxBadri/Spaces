import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import { manifestSchema } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { Enqueue } from '../../queue/enqueue'
import { pluginQueueName } from '../../queue/names'
import type { PluginQueueName } from '../../queue/names'

/**
 * The domain-event dispatcher: an emitted event becomes one
 * `plugin.<id>.<job>` enqueue per subscribed event job, through the
 * process's own `Enqueue`. No outbox, no NOTIFY bus. (D65)
 * - Runnable means `enabled` and status `enabled`: one predicate skips a
 *   degraded, an operator-disabled and a breaker-tripped row alike.
 * - `config.autoEnrich === true` is the switch; absent or anything else is off.
 * - Never fails: the write that emitted the event has already committed.
 */

/** Births that fan out into nothing: seeding and a spreadsheet. */
const SILENT_BIRTHS: ReadonlySet<SourceClass> = new Set(['seed', 'import'])

/**
 * The `entity.created` a committed birth emits, or null for a silent one.
 * Built by the write path that did the birth; dispatched by whoever owns
 * its commit.
 */
export const entityCreated = (
  entityId: string,
  kind: DomainEvent['kind'],
  sourceClass: SourceClass,
  at: Date = new Date(),
): DomainEvent | null =>
  SILENT_BIRTHS.has(sourceClass)
    ? null
    : {
        name: 'entity.created',
        entityId,
        kind,
        occurredAt: at.toISOString(),
      }

/** An integration row, as far as the dispatcher reads it. */
export type SubscriberRow = {
  readonly config: { readonly [k: string]: unknown }
  readonly manifest: unknown
}

/** The queues subscribed to `event` across these rows, each named once. */
export const subscribedQueues = (
  event: DomainEvent,
  rows: ReadonlyArray<SubscriberRow>,
): ReadonlyArray<PluginQueueName> => {
  const queues = new Set<PluginQueueName>()
  for (const row of rows) {
    if (row.config.autoEnrich !== true) continue
    const parsed = manifestSchema.safeParse(row.manifest)
    if (!parsed.success) continue
    for (const [job, declared] of Object.entries(parsed.data.jobs)) {
      if (declared.trigger !== 'event') continue
      if (!(declared.on ?? []).includes(event.name)) continue
      queues.add(
        pluginQueueName(parsed.data.id, job, declared.interactive === true),
      )
    }
  }
  return [...queues]
}

/** The runnable integration rows. */
const runnableRows = Effect.tryPromise(() =>
  db
    .select({ config: integration.config, manifest: integration.manifest })
    .from(integration)
    .where(
      and(eq(integration.enabled, true), eq(integration.status, 'enabled')),
    ),
)

/**
 * Dispatch one event; answers the queues it was sent to. A null event — an
 * attach, a silent birth — dispatches nothing and reads nothing.
 */
export const dispatchDomainEvent: (
  event: DomainEvent | null,
) => Effect.Effect<ReadonlyArray<PluginQueueName>, never, Enqueue> = Effect.fn(
  'dispatchDomainEvent',
)(
  function* (event: DomainEvent | null) {
    if (event === null) return []
    const queues = subscribedQueues(event, yield* runnableRows)
    if (queues.length === 0) return []
    const sender = yield* Enqueue
    const data = {
      event: {
        name: event.name,
        entityId: event.entityId,
        kind: event.kind,
        occurredAt: event.occurredAt,
      },
    }
    for (const queue of queues) yield* sender.enqueue(queue, data)
    return queues
  },
  Effect.catchCause((cause) =>
    Effect.logError('[events] dispatch failed', cause).pipe(
      Effect.as<ReadonlyArray<PluginQueueName>>([]),
    ),
  ),
)
