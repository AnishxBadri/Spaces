import { Clock, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { isNotNull, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { enrichmentRecord, integration } from '@spaces/db/schema'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { nextUtcMidnight } from '@spaces/core/ai/caps'
import { enrichmentRunData } from '@spaces/core/enrichment/auto'
import { EnrichmentSources } from '@spaces/core/enrichment/sources'
import type { AskResult } from '@spaces/core/enrichment/sources'
import { WebsiteReader } from '@spaces/core/enrichment/website'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  bulkEnrichProgram,
  bulkEstimateProgram,
} from '@spaces/core/writes/enrichment/estimate'
import { runEnrichment } from '@spaces/core/writes/enrichment/run'
import { ModelCall } from '@spaces/core/writes/ports/ai'
import { guardAction } from './credit'
import { workerEnqueue } from './enqueue'

/**
 * A list's Enrich… on a real pg-boss: one job per record through the
 * singleton key, a second press doubling none, and the records past the
 * cap parked until 00:00 UTC and asked once the clock has passed it.
 * (D53, D76)
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
        config: { dailyCreditCap: CAP },
        manifest: paid,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no row')
  source = row.id
})

/** The source as the worker asks it: the real credit guard, then one credit spent. */
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
      name: `Bulk ${String(++n)}`,
      keys: { domain: `bulk-${String(Date.now())}-${String(n)}.example` },
      source: { class: 'import' },
    })
  ).entityId

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
      ...(job.bulk === undefined ? {} : { bulk: job.bulk }),
    }),
    now,
  )
}

describe('Enrich… on a list', () => {
  it('queues one job per record, doubles none, parks past the cap and runs the parked after the reset', async () => {
    const now = Date.now()
    const midnight = nextUtcMidnight(new Date(now))
    asked.length = 0
    const ids: Array<string> = []
    for (let i = 0; i < 5; i++) ids.push(await company())

    const out = await at(bulkEnrichProgram('company', ids), now)
    expect(out).toEqual({
      queued: 3,
      parked: 2,
      already: 0,
      resumesAt: midnight.toISOString(),
    })
    for (const id of ids) expect((await jobsFor(id)).rows).toHaveLength(1)
    const parked = ids.slice(3)
    for (const id of parked)
      expect((await jobsFor(id)).rows.at(0)).toMatchObject({
        state: 'created',
        start_ms: midnight.getTime(),
        data: expect.objectContaining({ parkedBy: source, bulk: true }),
      })

    // Pressed again: every record already waits, so nothing is asked or sent.
    const estimate = await at(bulkEstimateProgram('company', ids), now)
    expect(estimate).toMatchObject({ ask: 0, skipped: { queued: 5 } })
    const again = await at(bulkEnrichProgram('company', ids), now)
    expect(again).toMatchObject({ queued: 0, parked: 0 })
    for (const id of ids) expect((await jobsFor(id)).rows).toHaveLength(1)

    // The worker runs what is due now: the three under the cap.
    const due = await boss.fetch(QUEUE, { batchSize: 10 })
    expect(due).toHaveLength(3)
    for (const job of due) {
      await runJob(job.data, now)
      await boss.complete(QUEUE, job.id)
    }
    expect([...asked].sort()).toEqual(ids.slice(0, 3).sort())
    expect(await boss.fetch(QUEUE)).toEqual([])

    // Past midnight the parked runs ask the source.
    const after = midnight.getTime() + 1_000
    for (const id of parked) {
      const job = (await jobsFor(id)).rows.at(0)
      const ran = await runJob(job?.['data'], after)
      expect(ran.parked).toBeNull()
    }
    expect([...asked].sort()).toEqual([...ids].sort())
  })
})
