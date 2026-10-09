import { Effect } from 'effect'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  link,
  space,
} from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import { manifestSchema } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { autoEnrichScopeOf, inScope } from '@spaces/core/plugins/auto-enrich'
import type {
  AutoEnrichScope,
  ScopeFacts,
} from '@spaces/core/plugins/auto-enrich'
import { workspace } from '@spaces/db/schema/workspace'
import { enrichmentSettingsOf, scopeFor } from '../../enrichment/settings'
import { Enqueue } from '../../queue/enqueue'
import { pluginQueueName } from '../../queue/names'
import type { PluginQueueName } from '../../queue/names'
import type { DealParty } from '../attributes/values'

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

const read = <T>(run: () => Promise<T>) => Effect.tryPromise(run)

/** Whether the record is a party of a live deal: its `company` or one of its `people`. */
const isDealParty = (entityId: string) =>
  read(async () => {
    const hit = await db
      .select({ id: link.id })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, entityId),
          eq(link.relation, 'references'),
          inArray(link.attrSlug, ['company', 'people']),
          eq(entity.kind, 'deal'),
          isNull(entity.mergedIntoId),
        ),
      )
      .limit(1)
    return hit.length > 0
  })

/** Space paths by id. */
const spacePaths = (ids: ReadonlyArray<string>) =>
  read(async () =>
    ids.length === 0
      ? new Map<string, string>()
      : new Map(
          (
            await db
              .select({ id: space.entityId, path: space.path })
              .from(space)
              .where(inArray(space.entityId, [...ids]))
          ).map((r) => [r.id, r.path]),
        ),
  )

/** The paths of every space the record is filed in. */
const filedPathsOf = (entityId: string) =>
  read(async () =>
    (
      await db
        .select({ path: space.path })
        .from(entitySpace)
        .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
        .where(eq(entitySpace.entityId, entityId))
    ).map((r) => r.path),
  )

/** What the scopes ask about the event's record, read only as far as asked. */
const scopeFacts = Effect.fn('scopeFacts')(function* (
  event: DomainEvent,
  subs: ReadonlyArray<Subscription>,
) {
  const chosen = [...new Set(subs.flatMap((s) => s.scope.spaces))]
  const wantsSpace = subs.some((s) => s.scope.scopes.includes('space'))
  const wantsDeal = subs.some((s) => s.scope.scopes.includes('deal'))
  const chosenPaths = wantsSpace ? yield* spacePaths(chosen) : new Map()
  switch (event.name) {
    case 'deal.linked':
      return { dealParty: true, filedPaths: [], chosenPaths }
    case 'filed': {
      const own = wantsSpace
        ? (yield* spacePaths([event.spaceId])).get(event.spaceId)
        : undefined
      return {
        dealParty: false,
        filedPaths: own === undefined ? [] : [own],
        chosenPaths,
      }
    }
    case 'entity.created':
      return {
        dealParty: wantsDeal ? yield* isDealParty(event.entityId) : false,
        filedPaths: wantsSpace ? yield* filedPathsOf(event.entityId) : [],
        chosenPaths,
      }
  }
})

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
  }
}

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
    const settings = yield* enrichmentSettings
    const subs = subscriptions(event, yield* runnableRows, (row) =>
      scopeFor(settings, row.id, row.config),
    )
    if (subs.length === 0) return []
    const queues = queuesInScope(event, subs, yield* scopeFacts(event, subs))
    if (queues.length === 0) return []
    const sender = yield* Enqueue
    const data = eventData(event)
    for (const queue of queues) yield* sender.enqueue(queue, data)
    return queues
  },
  Effect.catchCause((cause) =>
    Effect.logError('[events] dispatch failed', cause).pipe(
      Effect.as<ReadonlyArray<PluginQueueName>>([]),
    ),
  ),
)
