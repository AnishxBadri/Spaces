import { randomUUID } from 'node:crypto'
import { Clock, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { and, eq, isNotNull, like } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { nextUtcMidnight } from '../../ai/caps'
import { AUTO_ENRICH_CHECKS } from '../../enrichment/auto'
import type { AutoEnrichOutcome } from '../../enrichment/auto'
import { enrichmentSettingsOf } from '../../enrichment/settings'
import { EnrichmentSources } from '../../enrichment/sources'
import { WebsiteReader } from '../../enrichment/website'
import { jsonRecord, jsonValue } from '../../json'
import { capRefusal } from '@spaces/core/plugins/credit'
import { Enqueue } from '../../queue/enqueue'
import type { EnqueueOptions } from '../../queue/sender'
import { setValues } from '../attributes/values'
import { resolveEntity } from '../entities/resolve'
import { dispatchDomainEvent } from '../events/dispatch'
import { writeIntegrationInteraction } from '../interactions/write'
import { ModelCall } from '../ports/ai'
import { autoEnrichProgram } from './auto'
import { runEnrichment } from './run'

/**
 * The host's auto-enrich checks against a real database, on an `Enqueue`
 * that keeps pg-boss's stately singleton rule — one queued job per key —
 * and a clock the test sets. (D76)
 */

type Sent = {
  readonly queue: string
  readonly data: Record<string, unknown>
  readonly options: EnqueueOptions | undefined
}
const sent: Array<Sent> = []
const queuedKeys = new Set<string>()
const singleton = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data, options) =>
      Effect.sync(() => {
        const key =
          options?.singletonKey === undefined
            ? null
            : `${queue}:${options.singletonKey}`
        if (key !== null && queuedKeys.has(key)) return null
        if (key !== null) queuedKeys.add(key)
        sent.push({ queue, data, options })
        return `job-${String(sent.length)}`
      }),
  }),
)

const NOW = Date.parse('2026-10-10T15:30:00.000Z')
const withClock = <TOut, TErr>(
  effect: Effect.Effect<TOut, TErr, Enqueue>,
  at: number = Date.now(),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      yield* clock.setTime(at)
      return yield* effect.pipe(Effect.provideService(Clock.Clock, clock))
    }).pipe(Effect.scoped, Effect.provide(singleton)),
  )

const manifest = (id: string) =>
  jsonRecord(
    jsonValue.parse(
      toManifestJson(
        defineManifest({
          manifestVersion: 1,
          id,
          version: '0.1.0',
          sdk: '^1.3',
          name: 'Paid',
          description: 'A paid source.',
          settings: z.object({}),
          jobs: {
            enrichCompany: { trigger: 'action', uses: ['Facts'] },
            enrichPerson: { trigger: 'action', uses: ['Facts'] },
            autoEnrich: {
              trigger: 'event',
              on: ['entity.created', 'deal.linked', 'identity.added'],
              uses: ['Read'],
            },
          },
          actions: [
            {
              id: 'enrich-company',
              label: 'Enrich',
              on: 'company',
              job: 'enrichCompany',
            },
            {
              id: 'enrich-person',
              label: 'Enrich',
              on: 'person',
              job: 'enrichPerson',
            },
          ],
        }),
      ),
    ),
  )

type Config = { [k: string]: string | number | Array<string> }

const installSource = async (config: Config = {}) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: `auto-${randomUUID().slice(0, 8)}`,
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        config: { autoEnrichScopes: ['deal'], dailyCreditCap: 3, ...config },
        manifest: manifest('auto'),
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no row')
  return row.id
}

const setConfig = (id: string, config: Config) =>
  db
    .update(integration)
    .set({
      config: { autoEnrichScopes: ['deal'], dailyCreditCap: 3, ...config },
    })
    .where(eq(integration.id, id))

const rows = () =>
  db
    .select({
      id: integration.id,
      config: integration.config,
      manifest: integration.manifest,
    })
    .from(integration)
    .where(
      and(
        eq(integration.enabled, true),
        like(integration.capabilityId, 'auto-%'),
      ),
    )

let n = 0
const company = async (withDomain = true) =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Auto Co ${String(++n)}`,
      keys: withDomain
        ? { domain: `auto-${String(Date.now())}-${String(n)}.example` }
        : {},
      source: { class: 'manual' },
    })
  ).entityId

const linked = (entityId: string): DomainEvent => ({
  name: 'deal.linked',
  entityId,
  kind: 'company',
  dealId: randomUUID(),
  occurredAt: new Date(NOW).toISOString(),
})

const receipt = (
  entityId: string,
  integrationId: string,
  credits: number,
  fetchedAt: Date = new Date(),
) =>
  db.insert(enrichmentRecord).values({
    entityId,
    provider: 'auto',
    integrationId,
    raw: {},
    creditsUsed: credits,
    fetchedAt,
  })

const auto = async (event: DomainEvent, at: number = Date.now()) =>
  withClock(
    Effect.gen(function* () {
      const ctx = {
        settings: enrichmentSettingsOf({}),
        rows: yield* Effect.promise(rows),
      }
      return yield* autoEnrichProgram(event, ctx)
    }),
    at,
  )

const outcomeOf = (o: AutoEnrichOutcome) =>
  o.outcome === 'skipped' ? o.check : o.outcome

const actorId = async () => {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('no fixture user')
  return row.id
}

beforeEach(async () => {
  sent.length = 0
  queuedKeys.clear()
  await db.delete(enrichmentRecord).where(isNotNull(enrichmentRecord.id))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(like(integration.capabilityId, 'auto-%'))
})

describe('the host checks, in order', () => {
  it('names the checks in D76 order', () => {
    expect(AUTO_ENRICH_CHECKS).toEqual([
      'scope',
      'sensitive',
      'reuse',
      'key',
      'queued',
      'credits',
    ])
  })

  it('a record that passes every check queues one run, keyed on the record, for the sources in scope', async () => {
    const source = await installSource()
    const id = await company()
    const out = await auto(linked(id))
    expect(out).toMatchObject({ outcome: 'queued', sources: [source] })
    expect(sent).toEqual([
      {
        queue: 'enrichment.run',
        data: {
          entityId: id,
          reason: 'Auto-enrich · deal.linked',
          sources: [source],
          trigger: 'deal.linked',
        },
        options: { singletonKey: id },
      },
    ])
  })

  // Each fixture fails exactly one check; every other check would pass.
  const fixtures: ReadonlyArray<
    [string, (source: string, id: string) => Promise<void>, boolean]
  > = [
    [
      'scope',
      (source) =>
        setConfig(source, { autoEnrichScopes: ['space'] }).then(
          () => undefined,
        ),
      true,
    ],
    [
      'sensitive',
      async (_, id) => {
        await db
          .update(entity)
          .set({ sensitive: true })
          .where(eq(entity.id, id))
      },
      true,
    ],
    [
      'reuse',
      async (source, id) => {
        await receipt(id, source, 0, new Date(Date.now() - 10 * 86_400_000))
      },
      true,
    ],
    ['key', async () => undefined, false],
    [
      'queued',
      async (_, id) => {
        queuedKeys.add(`enrichment.run:${id}`)
      },
      true,
    ],
  ]

  it.each(fixtures)(
    'a record failing only %s is not queued',
    async (check, fail, withDomain) => {
      const source = await installSource()
      const id = await company(withDomain)
      await fail(source, id)
      const out = await auto(linked(id))
      expect(outcomeOf(out)).toBe(check)
      expect(sent).toEqual([])
    },
  )

  it('a record failing only credits is parked until the next 00:00 UTC, never dropped', async () => {
    const source = await installSource()
    await receipt(await company(), source, 3, new Date(NOW))
    const id = await company()
    const out = await auto(linked(id), NOW)
    expect(out).toMatchObject({
      outcome: 'parked',
      parkedBy: source,
      startAfter: new Date('2026-10-11T00:00:00.000Z'),
    })
    expect(sent.at(0)?.options).toEqual({
      singletonKey: id,
      startAfter: new Date('2026-10-11T00:00:00.000Z'),
    })
    expect(sent.at(0)?.data).toMatchObject({ parkedBy: source })
  })

  it('a record failing every check reports them one by one, in order', async () => {
    const source = await installSource({ autoEnrichScopes: ['space'] })
    await receipt(await company(), source, 3)
    const id = await company(false)
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    await receipt(id, source, 0)
    queuedKeys.add(`enrichment.run:${id}`)
    const seen: Array<string> = []
    const step = async () => seen.push(outcomeOf(await auto(linked(id))))

    await step()
    await setConfig(source, {})
    await step()
    await db.update(entity).set({ sensitive: false }).where(eq(entity.id, id))
    await step()
    await db.delete(enrichmentRecord).where(eq(enrichmentRecord.entityId, id))
    await step()
    await setValues({
      entityId: id,
      patch: { domains: [`late-${String(Date.now())}.example`] },
      actor: { type: 'user', id: await actorId() },
    })
    await step()
    queuedKeys.clear()
    await step()
    await setConfig(source, { dailyCreditCap: 100 })
    queuedKeys.clear()
    await step()
    expect(seen).toEqual([
      'scope',
      'sensitive',
      'reuse',
      'key',
      'queued',
      'parked',
      'queued',
    ])
  })

  it('a receipt older than reuseDays does not stop the run', async () => {
    const source = await installSource()
    const id = await company()
    await receipt(id, source, 0, new Date(Date.now() - 100 * 86_400_000))
    expect(outcomeOf(await auto(linked(id)))).toBe('queued')
  })

  it('two triggers for one record queue one job', async () => {
    await installSource()
    const id = await company()
    // The record joins two deals before its run starts.
    const first = await auto(linked(id))
    const second = await auto(linked(id))
    expect(first.outcome).toBe('queued')
    expect(second).toEqual({ outcome: 'skipped', check: 'queued' })
    expect(sent).toHaveLength(1)
  })
})

describe('interaction.logged', () => {
  /** A synced meeting with one outside person in it: the events its write hands back. */
  const meetingWith = async () => {
    const calendar = (
      await db
        .insert(integration)
        .values({ capabilityId: 'google-calendar', version: '1.0.0' })
        .returning({ id: integration.id })
    ).at(0)
    if (!calendar) throw new Error('no calendar row')
    const personId = (
      await resolveEntity({
        kind: 'person',
        name: 'Priya',
        keys: { email: `priya-${String(++n)}@meeting-auto.example` },
        source: { class: 'manual' },
      })
    ).entityId
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, {
        integrationId: calendar.id,
        kind: 'meeting',
        messageId: `uid-${randomUUID()}`,
        threadId: null,
        subject: 'Intro',
        occurredAt: new Date(NOW),
        body: null,
        edges: [personId],
      }),
    )
    if (written.kind !== 'written') throw new Error('no meeting')
    return { personId, events: written.events }
  }

  it('a participant of a synced meeting is enriched once when the meeting scope is on', async () => {
    const source = await installSource({ autoEnrichScopes: ['meeting'] })
    const { personId, events } = await meetingWith()
    expect(events).toEqual([
      expect.objectContaining({
        name: 'interaction.logged',
        entityId: personId,
        kind: 'person',
        interactionKind: 'meeting',
      }),
    ])
    const [logged] = events
    expect(await withClock(dispatchDomainEvent(logged))).toEqual([
      'enrichment.run',
    ])
    // The same person in a second meeting before the run: still one job.
    await withClock(dispatchDomainEvent(logged))
    expect(sent).toHaveLength(1)
    expect(sent.at(0)?.data).toMatchObject({
      entityId: personId,
      trigger: 'interaction.logged',
      sources: [source],
    })
  })

  it('and not when it is off', async () => {
    await installSource({ autoEnrichScopes: ['deal'] })
    const { events } = await meetingWith()
    const [logged] = events
    expect(outcomeOf(await auto(logged))).toBe('scope')
    expect(await withClock(dispatchDomainEvent(logged))).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('identity.added', () => {
  it('setValues hands back a domain added after birth, once; a birth or a re-write adds none', async () => {
    const id = await company(false)
    const actor = { type: 'user' as const, id: await actorId() }
    const d = `gained-${String(Date.now())}.example`
    const first = await setValues({
      entityId: id,
      patch: { domains: [d] },
      actor,
    })
    expect(first.identityAdded).toEqual([
      expect.objectContaining({
        name: 'identity.added',
        entityId: id,
        kind: 'company',
        key: 'domain',
        value: d,
      }),
    ])
    const again = await setValues({
      entityId: id,
      patch: { domains: [d] },
      actor,
    })
    expect(again.identityAdded).toEqual([])
    const imported = await setValues({
      entityId: id,
      patch: { domains: [d, `imported-${String(Date.now())}.example`] },
      actor,
      source: 'import',
    })
    expect(imported.identityAdded).toEqual([])
  })

  it('a company born without a domain never queues; adding one enriches it once', async () => {
    await installSource({ autoEnrichScopes: ['deal'] })
    const id = await company(false)
    // A deal party: in scope, but nothing to look up by.
    expect(outcomeOf(await auto(linked(id)))).toBe('key')
    expect(sent).toEqual([])

    const written = await setValues({
      entityId: id,
      patch: { domains: [`now-${String(Date.now())}.example`] },
      actor: { type: 'user', id: await actorId() },
    })
    const added = written.identityAdded.at(0)
    if (added === undefined) throw new Error('no identity.added')
    // In scope as a party of a live deal: the event reads the record's standing.
    const deal = (
      await db
        .insert(entity)
        .values({ kind: 'deal', canonicalName: 'Deal', sourceClass: 'manual' })
        .returning({ id: entity.id })
    ).at(0)
    if (!deal) throw new Error('no deal')
    await setValues({
      entityId: deal.id,
      patch: { company: id },
      actor: { type: 'user', id: await actorId() },
    })
    const queues = await withClock(dispatchDomainEvent(added))
    expect(queues).toEqual(['enrichment.run'])
    expect(sent.map((s) => s.data['trigger'])).toEqual(['identity.added'])
    // A second trigger before the run: still one job.
    await withClock(dispatchDomainEvent(added))
    expect(sent).toHaveLength(1)
  })

  it('an enrichment source’s own event job is not sent: auto-enrich is the host’s run', async () => {
    await installSource()
    const id = await company()
    const queues = await withClock(dispatchDomainEvent(linked(id)))
    expect(queues).toEqual(['enrichment.run'])
    expect(sent.map((s) => s.queue)).toEqual(['enrichment.run'])
  })
})

describe('a run refused at the cap', () => {
  const NoModel = Layer.mergeAll(
    Layer.succeed(
      WebsiteReader,
      WebsiteReader.of({
        fetch: () => Effect.die(new Error('no fetch expected')),
        extractRoute: () => Effect.succeed('unrouted'),
      }),
    ),
    Layer.succeed(
      ModelCall,
      ModelCall.of({ complete: () => Effect.die(new Error('no call')) }),
    ),
  )
  const capped = Layer.succeed(
    EnrichmentSources,
    EnrichmentSources.of({
      ask: () => Effect.succeed({ asked: false, reason: capRefusal(3) }),
    }),
  )
  const run = (id: string, trigger?: 'deal.linked') =>
    withClock(
      runEnrichment(id, 'Auto-enrich · deal.linked', {
        ...(trigger === undefined ? {} : { trigger }),
      }).pipe(Effect.provide(Layer.merge(NoModel, capped))),
      NOW,
    )

  it('an auto run re-queues itself for the capped source at the next 00:00 UTC', async () => {
    const source = await installSource()
    const id = await company()
    const out = await run(id, 'deal.linked')
    expect(out.parked).toEqual({
      by: source,
      startAfter: nextUtcMidnight(new Date(NOW)).toISOString(),
    })
    expect(sent).toEqual([
      {
        queue: 'enrichment.run',
        data: {
          entityId: id,
          reason: 'Auto-enrich · deal.linked',
          sources: [source],
          trigger: 'deal.linked',
          parkedBy: source,
        },
        options: {
          singletonKey: id,
          startAfter: new Date('2026-10-11T00:00:00.000Z'),
        },
      },
    ])
  })

  it('a pressed Enrich at the cap is not parked', async () => {
    await installSource()
    const out = await run(await company())
    expect(out.parked).toBeNull()
    expect(sent).toEqual([])
  })
})
