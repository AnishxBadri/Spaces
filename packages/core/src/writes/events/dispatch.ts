import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import { manifestSchema } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { autoEnrichScopeOf, inScope } from '@spaces/core/plugins/auto-enrich'
import type {
  AutoEnrichScope,
  ScopeFacts,
} from '@spaces/core/plugins/auto-enrich'
import { workspace } from '@spaces/db/schema/workspace'
import {
  enrichActionFor,
  enrichmentSettingsOf,
  scopeFor,
} from '../../enrichment/settings'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES, pluginQueueName } from '../../queue/names'
import type { EnqueueTarget, PluginQueueName } from '../../queue/names'
import type { DealParty } from '../attributes/values'
import { autoEnrichProgram } from '../enrichment/auto'
import { scopeFacts } from './scope-facts'

/**
 * The domain-event dispatcher: an emitted event becomes one
 * `plugin.<id>.<job>` enqueue per subscribed event job, through the
 * process's own `Enqueue`. No outbox, no NOTIFY bus. (D65)
 * - Runnable means `enabled` and status `enabled`: one predicate skips a
 *   degraded, an operator-disabled and a breaker-tripped row alike.
 * - A row's auto-enrich scope (`scopeFor`: the workspace's enrichment
 *   settings, else the row's config) gates every event job
 *   it declares: an event about a record outside the scope enqueues nothing.
 * - One enqueue per subscribed queue per event, never one per job match.
 * - An enrichment source's event jobs are not sent: auto-enrich is the
 *   host's `enrichment.run`, queued behind its checks (`autoEnrichProgram`).
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

/** The `filed` a committed `entity_space` insert emits; null for a kind no event names. */
export const filed = (
  entityId: string,
  kind: string,
  spaceId: string,
  at: Date = new Date(),
): DomainEvent | null =>
  kind === 'company' || kind === 'person' || kind === 'deal'
    ? { name: 'filed', entityId, kind, spaceId, occurredAt: at.toISOString() }
    : null

/** The `deal.linked` a new deal party emits, or null for a silent write. */
export const dealLinked = (
  party: DealParty,
  sourceClass: SourceClass,
  at: Date = new Date(),
): DomainEvent | null =>
  SILENT_BIRTHS.has(sourceClass)
    ? null
    : {
        name: 'deal.linked',
        entityId: party.entityId,
        kind: party.kind,
        dealId: party.dealId,
        occurredAt: at.toISOString(),
      }

/** An integration row, as far as the dispatcher reads it. */
export type SubscriberRow = {
  readonly config: { readonly [k: string]: unknown }
  readonly manifest: unknown
}

/** One row's queues subscribed to `event`, with the scope that gates them. */
export type Subscription = {
  readonly scope: AutoEnrichScope
  readonly queues: ReadonlyArray<PluginQueueName>
}

/** Each row's queues subscribed to `event`; rows with none are left out. */
export const subscriptions = <TRow extends SubscriberRow>(
  event: DomainEvent,
  rows: ReadonlyArray<TRow>,
  scopeOf: (row: TRow) => AutoEnrichScope = (row) =>
    autoEnrichScopeOf(row.config),
): ReadonlyArray<Subscription> => {
  const out: Array<Subscription> = []
  for (const row of rows) {
    const parsed = manifestSchema.safeParse(row.manifest)
    if (!parsed.success) continue
    const queues: Array<PluginQueueName> = []
    for (const [job, declared] of Object.entries(parsed.data.jobs)) {
      if (declared.trigger !== 'event') continue
      if (!(declared.on ?? []).includes(event.name)) continue
      queues.push(
        pluginQueueName(parsed.data.id, job, declared.interactive === true),
      )
    }
    if (queues.length > 0) out.push({ scope: scopeOf(row), queues })
  }
  return out
}

/** The subscribed queues whose row has `event` in scope, each named once. */
const queuesInScope = (
  event: DomainEvent,
  subs: ReadonlyArray<Subscription>,
  facts: ScopeFacts,
): ReadonlyArray<PluginQueueName> => {
  const queues = new Set<PluginQueueName>()
  for (const sub of subs)
    if (inScope(sub.scope, event, facts))
      for (const q of sub.queues) queues.add(q)
  return [...queues]
}

/** The queues to send `event` to: subscribed, and in the row's scope, each once. */
export const subscribedQueues = (
  event: DomainEvent,
  rows: ReadonlyArray<SubscriberRow>,
  facts: ScopeFacts,
): ReadonlyArray<PluginQueueName> =>
  queuesInScope(event, subscriptions(event, rows), facts)

/** The job's input: the event's own fields, built field by field. */
const eventData = (event: DomainEvent) => {
  const base = {
    entityId: event.entityId,
    kind: event.kind,
    occurredAt: event.occurredAt,
  }
  switch (event.name) {
    case 'entity.created':
      return { event: { name: event.name, ...base } }
    case 'filed':
      return { event: { name: event.name, ...base, spaceId: event.spaceId } }
    case 'deal.linked':
      return { event: { name: event.name, ...base, dealId: event.dealId } }
    case 'identity.added':
      return {
        event: {
          name: event.name,
          ...base,
          key: event.key,
          value: event.value,
        },
      }
  }
}

/** A source the host's enrichment run asks: an enrich action for a record kind. */
const isEnrichmentSource = (manifest: unknown) =>
  enrichActionFor(manifest, 'company') !== null ||
  enrichActionFor(manifest, 'person') !== null

/** The runnable integration rows. */
const runnableRows = Effect.tryPromise(() =>
  db
    .select({
      id: integration.id,
      config: integration.config,
      manifest: integration.manifest,
    })
    .from(integration)
    .where(
      and(eq(integration.enabled, true), eq(integration.status, 'enabled')),
    ),
)

/** The workspace's enrichment settings, which hold the scopes once moved. */
const enrichmentSettings = Effect.tryPromise(async () =>
  enrichmentSettingsOf(
    (
      await db.select({ settings: workspace.settings }).from(workspace).limit(1)
    ).at(0)?.settings ?? {},
  ),
)

/**
 * Dispatch one event; answers the queues it was sent to, `enrichment.run`
 * among them when auto-enrich queued or parked a run. A null event — an
 * attach, a silent birth — dispatches nothing and reads nothing.
 */
export const dispatchDomainEvent: (
  event: DomainEvent | null,
) => Effect.Effect<ReadonlyArray<EnqueueTarget>, never, Enqueue> = Effect.fn(
  'dispatchDomainEvent',
)(
  function* (event: DomainEvent | null) {
    if (event === null) return []
    const settings = yield* enrichmentSettings
    const rows = yield* runnableRows
    const sent: Array<EnqueueTarget> = []
    const subs = subscriptions(
      event,
      rows.filter((row) => !isEnrichmentSource(row.manifest)),
      (row) => scopeFor(settings, row.id, row.config),
    )
    if (subs.length > 0) {
      const facts = yield* scopeFacts(
        event,
        subs.map((s) => s.scope),
      )
      const queues = queuesInScope(event, subs, facts)
      const sender = yield* Enqueue
      const data = eventData(event)
      for (const queue of queues) yield* sender.enqueue(queue, data)
      sent.push(...queues)
    }
    const auto = yield* autoEnrichProgram(event, { settings, rows }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError('[events] auto-enrich failed', cause).pipe(
          Effect.as(null),
        ),
      ),
    )
    if (auto?.outcome === 'queued' || auto?.outcome === 'parked')
      sent.push(QUEUES.enrichmentRun)
    return sent
  },
  Effect.catchCause((cause) =>
    Effect.logError('[events] dispatch failed', cause).pipe(
      Effect.as<ReadonlyArray<EnqueueTarget>>([]),
    ),
  ),
)
