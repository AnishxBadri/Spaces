import { randomUUID } from 'node:crypto'
import { Clock, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { eq, isNotNull, like } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { nextUtcMidnight } from '../../ai/caps'
import { BULK_REASON } from '../../enrichment/estimate'
import { EnrichmentSources } from '../../enrichment/sources'
import { WebsiteReader } from '../../enrichment/website'
import { jsonRecord, jsonValue } from '../../json'
import { capRefusal } from '@spaces/core/plugins/credit'
import { Enqueue } from '../../queue/enqueue'
import type { EnqueueOptions } from '../../queue/sender'
import { resolveEntity } from '../entities/resolve'
import { ModelCall } from '../ports/ai'
import { enrichmentRow } from './apply'
import { bulkEnrichProgram, bulkEstimateProgram } from './estimate'
import { runEnrichment } from './run'

/**
 * Bulk Enrich against a real database, on an `Enqueue` that keeps
 * pg-boss's singleton rule — one queued job per key — and a set clock.
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
const MIDNIGHT = new Date('2026-10-11T00:00:00.000Z')

const at = <TOut, TErr>(effect: Effect.Effect<TOut, TErr, Enqueue>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      yield* clock.setTime(NOW)
      return yield* effect.pipe(Effect.provideService(Clock.Clock, clock))
    }).pipe(Effect.scoped, Effect.provide(singleton)),
  )

const manifest = jsonRecord(
  jsonValue.parse(
    toManifestJson(
      defineManifest({
        manifestVersion: 1,
        id: 'bulk',
        version: '0.1.0',
        sdk: '^1.3',
        name: 'Apollo',
        description: 'A paid source.',
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

const installSource = async (cap: number) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: `bulk-${randomUUID().slice(0, 8)}`,
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        config: { dailyCreditCap: cap },
        manifest,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no row')
  return row.id
}

let n = 0
const company = async (withDomain = true) =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Bulk Co ${String(++n)}`,
      keys: withDomain
        ? { domain: `bulk-${String(Date.now())}-${String(n)}.example` }
        : {},
      source: { class: 'import' },
    })
  ).entityId

const companies = async (count: number, withDomain = true) => {
  const ids: Array<string> = []
  for (let i = 0; i < count; i++) ids.push(await company(withDomain))
  return ids
}

const receipt = (
  entityId: string,
  integrationId: string,
  credits: number,
  fetchedAt: Date,
) =>
  db.insert(enrichmentRecord).values({
    entityId,
    provider: 'bulk',
    integrationId,
    raw: {},
    creditsUsed: credits,
    fetchedAt,
  })

beforeEach(async () => {
  sent.length = 0
  queuedKeys.clear()
  await db.delete(enrichmentRecord).where(isNotNull(enrichmentRecord.id))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(like(integration.capabilityId, 'bulk-%'))
})

describe('the estimate', () => {
  it('40 imported companies: the skips by reason, credits per source, and nothing sent', async () => {
    const source = await installSource(100)
    const ok = await companies(34)
    const sensitive = await companies(2)
    for (const id of sensitive)
      await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    const fresh = await companies(2)
    for (const id of fresh)
      await receipt(id, source, 0, new Date(NOW - 86_400_000))
    const keyless = await companies(2, false)
    const out = await at(
      bulkEstimateProgram('company', [
        ...ok,
        ...sensitive,
        ...fresh,
        ...keyless,
      ]),
    )
    // The Website reads a sensitive record too: it sends nothing out.
    expect(out).toMatchObject({
      total: 40,
      ask: 36,
      parks: 0,
      skipped: { sensitive: 0, reuse: 2, key: 2, queued: 0 },
    })
    expect(out.sources.at(0)).toMatchObject({
      name: 'Website',
      local: true,
      credits: 0,
    })
    expect(out.sources.slice(1)).toEqual([
      {
        id: source,
        name: 'Apollo',
        local: false,
        ask: 34,
        skipped: { sensitive: 2, reuse: 2, key: 2, queued: 0 },
        credits: 34,
        left: 100,
        parks: 0,
      },
    ])
    expect(sent).toEqual([])
    // Forty births one at a time: past the 5s default on a loaded machine.
  }, 30_000)

  it('a person among company ids is not considered', async () => {
    await installSource(100)
    const person = (
      await resolveEntity({
        kind: 'person',
        name: 'Not A Company',
        keys: { email: `p-${String(Date.now())}@bulk.example` },
        source: { class: 'import' },
      })
    ).entityId
    const out = await at(bulkEstimateProgram('company', [person]))
    expect(out.total).toBe(0)
  })

  it('the rate follows what the source has charged', async () => {
    const source = await installSource(100)
    const old = await company()
    await receipt(old, source, 2, new Date(NOW - 3 * 86_400_000))
    const ids = await companies(3)
    const out = await at(bulkEstimateProgram('company', ids))
    expect(out.sources.find((s) => s.id === source)).toMatchObject({
      ask: 3,
      credits: 6,
      left: 100,
    })
  })
})

describe('Enrich n', () => {
  it('sends one job per record asked, keyed on the record; a second press doubles none', async () => {
    const source = await installSource(100)
    const website = (await enrichmentRow()).id
    const ids = await companies(3)
    const keyless = await company(false)
    const out = await at(bulkEnrichProgram('company', [...ids, keyless]))
    expect(out).toEqual({ queued: 3, parked: 0, already: 0, resumesAt: null })
    expect(sent).toEqual(
      ids.map((id) => ({
        queue: 'enrichment.run',
        data: {
          entityId: id,
          reason: BULK_REASON,
          sources: [website, source],
          bulk: true,
        },
        options: { singletonKey: id },
      })),
    )
    const again = await at(bulkEnrichProgram('company', ids))
    expect(again).toEqual({ queued: 0, parked: 0, already: 3, resumesAt: null })
    expect(sent).toHaveLength(3)
  })

  it('over the cap, the records past what is left park until the next 00:00 UTC', async () => {
    const source = await installSource(10)
    for (const id of await companies(4))
      await receipt(id, source, 1, new Date(NOW - 60_000))
    const ids = await companies(10)
    const estimate = await at(bulkEstimateProgram('company', ids))
    expect(estimate).toMatchObject({ ask: 10, parks: 4 })
    expect(estimate.sources.find((s) => s.id === source)).toMatchObject({
      left: 6,
      parks: 4,
    })
    const out = await at(bulkEnrichProgram('company', ids))
    expect(out).toEqual({
      queued: 6,
      parked: 4,
      already: 0,
      resumesAt: MIDNIGHT.toISOString(),
    })
    const parked = sent.filter((s) => s.options?.startAfter !== undefined)
    expect(parked.map((s) => s.data['entityId'])).toEqual(ids.slice(6))
    for (const s of parked) {
      expect(s.options).toEqual({
        singletonKey: s.data['entityId'],
        startAfter: MIDNIGHT,
      })
      expect(s.data).toMatchObject({ parkedBy: source, bulk: true })
    }
  })
})

describe('a bulk run refused at the cap', () => {
  const NoModel = Layer.mergeAll(
    Layer.succeed(
      WebsiteReader,
      WebsiteReader.of({
        fetch: () => Effect.succeed({ ok: false, reason: 'offline' }),
        extractRoute: () => Effect.succeed('unrouted'),
      }),
    ),
    Layer.succeed(
      ModelCall,
      ModelCall.of({ complete: () => Effect.die(new Error('no call')) }),
    ),
    Layer.succeed(
      EnrichmentSources,
      EnrichmentSources.of({
        ask: () => Effect.succeed({ asked: false, reason: capRefusal(3) }),
      }),
    ),
  )

  it('re-queues itself for the capped source after the reset, still bulk', async () => {
    const source = await installSource(3)
    const id = await company()
    const out = await at(
      runEnrichment(id, BULK_REASON, { only: [source], bulk: true }).pipe(
        Effect.provide(NoModel),
      ),
    )
    expect(out.parked).toEqual({
      by: source,
      startAfter: nextUtcMidnight(new Date(NOW)).toISOString(),
    })
    expect(sent).toEqual([
      {
        queue: 'enrichment.run',
        data: {
          entityId: id,
          reason: BULK_REASON,
          sources: [source],
          bulk: true,
          parkedBy: source,
        },
        options: { singletonKey: id, startAfter: MIDNIGHT },
      },
    ])
  })
})
