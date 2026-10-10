import { Clock, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { nextUtcMidnight } from '@spaces/core/ai/caps'
import { enrichmentRunData } from '@spaces/core/enrichment/auto'
import { EnrichmentSources } from '@spaces/core/enrichment/sources'
import type { AskResult } from '@spaces/core/enrichment/sources'
import { WebsiteReader } from '@spaces/core/enrichment/website'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { parkedEnrichmentProgram } from '@spaces/core/writes/enrichment/parked'
import { runEnrichment } from '@spaces/core/writes/enrichment/run'
import { dispatchDomainEvent } from '@spaces/core/writes/events/dispatch'
import { ModelCall } from '@spaces/core/writes/ports/ai'
import { guardAction } from './credit'
import { workerEnqueue } from './enqueue'

/**
 * Auto-enrich at a source's daily cap, on a real pg-boss: one job per
 * record, the records past the cap parked until 00:00 UTC, the notices read
 * counting them, and the parked runs asking the source once the clock has
 * passed midnight. (D53, D76)
 */

const QUEUE = QUEUES.enrichmentRun
const CAP = 3

let boss: PgBoss
let connectionString: string

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (url === undefined) throw new Error('DATABASE_URL is unset')
  connectionString = url
  boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    schedule: false,
    supervise: false,
  })
  boss.on('error', (error: Error) => console.error('[pg-boss]', error))
  await boss.start()
  await boss.deleteQueue(QUEUE).catch(() => undefined)
  await boss.createQueue(QUEUE, { policy: 'stately' })
})

afterAll(async () => {
  await boss.stop({ graceful: false })
})

const paid = jsonRecord(
  jsonValue.parse(
    toManifestJson(
      defineManifest({
        manifestVersion: 1,
        id: 'paid',
        version: '0.1.0',
        sdk: '^1.3',
        name: 'Paid',
        description: 'A capped source.',
        settings: z.object({}),
        jobs: { enrichCompany: { trigger: 'action', uses: ['Facts'] } },
        actions: [
          {
            id: 'enrich-company',
            label: 'Enrich',
            on: 'company',
            job: 'enrichCompany',
          },
        ],
      }),
    ),
  ),
)

let source: string

beforeEach(async () => {
  await boss.deleteQueue(QUEUE).catch(() => undefined)
  await boss.createQueue(QUEUE, { policy: 'stately' })
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'paid',
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        config: { autoEnrichScopes: ['deal'], dailyCreditCap: CAP },
        manifest: paid,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no row')
  source = row.id
})

/**
 * The source as the worker asks it: the real credit guard against its row,
 * then one credit spent, stamped with Effect's clock.
 */
const asked: Array<string> = []
const runFixtures = Layer.mergeAll(
  Layer.succeed(
    EnrichmentSources,
    EnrichmentSources.of({
      ask: (integrationId, input) =>
        Effect.gen(function* () {
          const refused = yield* guardAction({
            integrationId,
            entityId: input.entityId,
            defaults: { cacheDays: 90, dailyCreditCap: null },
            cost: () => ({ credits: 1 }),
          }).pipe(
            Effect.as(null),
            Effect.catchTag('JobSkipped', (skip) =>
              Effect.succeed(skip.reason),
            ),
          )
          if (refused !== null) {
            const declined: AskResult = { asked: false, reason: refused }
            return declined
          }
          asked.push(input.entityId)
          const now = new Date(yield* Clock.currentTimeMillis)
          yield* Effect.promise(() =>
            db.insert(enrichmentRecord).values({
              entityId: input.entityId,
              provider: 'paid',
              integrationId,
              raw: {},
              creditsUsed: 1,
              fetchedAt: now,
            }),
          )
          const done: AskResult = { asked: true }
          return done
        }).pipe(Effect.orDie),
    }),
  ),
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

/** Effect's clock at `at`, the worker's own sender, and the run's fixtures. */
const at = <TOut, TErr>(
  effect: Effect.Effect<
    TOut,
    TErr,
    Enqueue | EnrichmentSources | WebsiteReader | ModelCall
  >,
  ms: number,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      yield* clock.setTime(ms)
      return yield* effect.pipe(Effect.provideService(Clock.Clock, clock))
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(workerEnqueue(connectionString), runFixtures),
      ),
    ),
  )

let n = 0
const company = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Parked ${String(++n)}`,
      keys: { domain: `parked-${String(Date.now())}-${String(n)}.example` },
      source: { class: 'manual' },
    })
  ).entityId

/** The record joins a deal: in the deal scope. */
const joins = (entityId: string, now: number): DomainEvent => ({
  name: 'deal.linked',
  entityId,
  kind: 'company',
  dealId: crypto.randomUUID(),
  occurredAt: new Date(now).toISOString(),
})

const jobsFor = (entityId: string) =>
  db.execute(
    sql`select state, (extract(epoch from start_after) * 1000)::float8 as start_ms, data
        from pgboss.job
        where name = ${QUEUE} and singleton_key = ${entityId}`,
  )

/** Run one fetched job the way the worker's handler does. */
const runJob = (data: unknown, now: number) => {
  const job = enrichmentRunData.parse(data)
  return at(
    runEnrichment(job.entityId, job.reason, {
      ...(job.sources === undefined ? {} : { only: job.sources }),
      ...(job.trigger === undefined ? {} : { trigger: job.trigger }),
    }),
    now,
  )
}

describe('one job per record', () => {
  it('two triggers for one record queue one job', async () => {
    const now = Date.now()
    const id = await company()
    await at(dispatchDomainEvent(joins(id, now)), now)
    await at(dispatchDomainEvent(joins(id, now)), now)
    expect((await jobsFor(id)).rows).toHaveLength(1)
  })
})

describe('the cap parks, and the reset runs what it parked', () => {
  it('three enrich, two park until 00:00 UTC; Today reads 2 waiting; past midnight they run and the count clears', async () => {
    const now = Date.now()
    const midnight = nextUtcMidnight(new Date(now))
    asked.length = 0
    const ids: Array<string> = []
    for (let i = 0; i < 5; i++) {
      const id = await company()
      ids.push(id)
      await at(dispatchDomainEvent(joins(id, now)), now)
      // The worker runs what is due now, one at a time.
      const due = await boss.fetch(QUEUE)
      for (const job of due) {
        await runJob(job.data, now)
        await boss.complete(QUEUE, job.id)
      }
    }
    expect(asked).toEqual(ids.slice(0, 3))

    const parked = ids.slice(3)
    for (const id of parked) {
      const rows = (await jobsFor(id)).rows
      expect(rows).toHaveLength(1)
      expect(rows.at(0)).toMatchObject({
        state: 'created',
        start_ms: midnight.getTime(),
        data: expect.objectContaining({ parkedBy: source }),
      })
    }
    // Nothing parked is due before midnight.
    expect(await boss.fetch(QUEUE)).toEqual([])

    expect(await at(parkedEnrichmentProgram(), now)).toEqual([
      {
        integrationId: source,
        source: 'Paid',
        waiting: 2,
        resumesAt: midnight.toISOString(),
      },
    ])

    // A parked run that starts early is refused again and stays parked.
    const early = (await jobsFor(parked[0] ?? '')).rows.at(0)
    const earlyOut = await runJob(early?.['data'], now)
    expect(earlyOut.ran).toBe(false)
    expect(earlyOut.parked?.startAfter).toBe(midnight.toISOString())
    expect((await jobsFor(parked[0] ?? '')).rows).toHaveLength(1)

    // The clock passes midnight: the parked runs ask the source.
    const after = midnight.getTime() + 1_000
    expect(await at(parkedEnrichmentProgram(), after)).toEqual([])
    for (const id of parked) {
      const job = (await jobsFor(id)).rows.at(0)
      const out = await runJob(job?.['data'], after)
      expect(out.parked).toBeNull()
    }
    expect(asked).toEqual(ids)
    const spentToday = await db
      .select({ id: enrichmentRecord.entityId })
      .from(enrichmentRecord)
      .where(
        and(
          eq(enrichmentRecord.integrationId, source),
          sql`${enrichmentRecord.fetchedAt} >= ${midnight.toISOString()}::timestamptz`,
        ),
      )
    expect(spentToday.map((r) => r.id).sort()).toEqual([...parked].sort())
  })

  it('a sensitive record never reaches the paid source', async () => {
    const now = Date.now()
    const id = await company()
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    expect(await at(dispatchDomainEvent(joins(id, now)), now)).toEqual([])
    expect((await jobsFor(id)).rows).toEqual([])
  })
})
