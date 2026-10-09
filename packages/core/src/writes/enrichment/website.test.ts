import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { enrichmentRecord, entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { EnrichmentSources } from '../../enrichment/sources'
import { WebsiteReader } from '../../enrichment/website'
import type { ExtractRoute, FetchedPage } from '../../enrichment/website'
import { jsonRecord } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import { resolveEntity } from '../entities/resolve'
import { ModelCall, ModelCallRefused } from '../ports/ai'
import type { ModelCallInput } from '../ports/ai'
import { ENRICHMENT_CAPABILITY } from './apply'
import { runEnrichment } from './run'

/**
 * The built-in Website inside a run, over a fake reader and model: where it
 * sits in the order, and what a sensitive record lets it do. The guarded
 * fetch and the real model call are the worker's test. (D76, D80)
 */

const HOME = `<html><head><title>Keyhold</title></head><body>
  <p>Keyhold runs key handover for rental homes.</p>
  <a href="https://www.linkedin.com/company/keyhold">LinkedIn</a>
</body></html>`

type Fake = {
  routes: { normal: ExtractRoute; sensitive: ExtractRoute }
  page: FetchedPage
  refusal?: string
  readonly fetched: Array<string>
  readonly calls: Array<ModelCallInput>
}

const fake = (over: Partial<Fake> = {}): Fake => ({
  routes: { normal: 'cloud', sensitive: 'unrouted' },
  page: {
    ok: true,
    url: 'https://keyhold.example/',
    contentType: 'text/html',
    bytes: new TextEncoder().encode(HOME),
  },
  fetched: [],
  calls: [],
  ...over,
})

const layers = (f: Fake) =>
  Layer.mergeAll(
    Layer.succeed(
      WebsiteReader,
      WebsiteReader.of({
        fetch: (url) =>
          Effect.sync(() => {
            f.fetched.push(url)
            return f.page
          }),
        extractRoute: (sensitivity) => Effect.succeed(f.routes[sensitivity]),
      }),
    ),
    Layer.succeed(
      ModelCall,
      ModelCall.of({
        complete: (input) =>
          Effect.suspend(() => {
            f.calls.push(input)
            return f.refusal === undefined
              ? Effect.succeed({
                  kind: 'object',
                  object: {
                    description: 'Keyhold runs key handover for rental homes.',
                    location: '',
                    linkedin: 'https://www.linkedin.com/company/keyhold',
                    twitter: '',
                    crunchbase: '',
                    blog: '',
                    logo: '',
                  },
                } as const)
              : Effect.fail(
                  new ModelCallRefused({
                    tag: f.refusal,
                    message: 'refused',
                    retryable: false,
                  }),
                )
          }),
      }),
    ),
    Layer.succeed(
      EnrichmentSources,
      EnrichmentSources.of({
        ask: () => Effect.succeed({ asked: false, reason: 'no plugin' }),
      }),
    ),
    Layer.succeed(Enqueue, Enqueue.of({ enqueue: () => Effect.succeed(null) })),
  )

const run = (entityId: string, f: Fake) =>
  Effect.runPromise(
    runEnrichment(entityId, 'test').pipe(Effect.provide(layers(f))),
  )

let n = 0
const company = async (domain: string | null) =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Keyhold ${++n}`,
      ...(domain === null ? {} : { keys: { domain } }),
      source: { class: 'manual' },
    })
  ).entityId

const sensitive = (id: string) =>
  db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))

const valuesOf = async (id: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)?.values ?? {}

const lineOf = async (id: string) =>
  (
    await db
      .select({ meta: activity.meta })
      .from(activity)
      .where(
        and(
          eq(activity.subjectEntityId, id),
          eq(activity.verb, 'entity.enriched'),
        ),
      )
  ).map((r) => jsonRecord(r.meta).line)

const websiteReceipts = async (id: string) =>
  (
    await db
      .select({
        raw: enrichmentRecord.raw,
        credits: enrichmentRecord.creditsUsed,
      })
      .from(enrichmentRecord)
      .where(
        and(
          eq(enrichmentRecord.entityId, id),
          eq(enrichmentRecord.provider, ENRICHMENT_CAPABILITY),
        ),
      )
  ).map((r) => ({ raw: jsonRecord(r.raw), credits: r.credits }))

describe('the Website in the order', () => {
  it('reads the domain with the owner’s Extract lane and fills the linked attributes', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    const f = fake()
    const outcome = await run(id, f)
    expect(outcome).toMatchObject({ ran: true, fields: 2, credits: 0 })
    expect(f.fetched).toEqual([`https://k${String(n)}.example/`])
    expect(f.calls.map((c) => [c.lane, c.caller.type])).toEqual([
      ['extract', 'integration'],
    ])
    const values = await valuesOf(id)
    expect(values['description']).toBe(
      'Keyhold runs key handover for rental homes.',
    )
    expect(values['linkedin']).toBe('https://www.linkedin.com/company/keyhold')
    expect(await lineOf(id)).toEqual(['Enriched · Website · 2 fields'])
  })

  it('is absent with no AI model set up, and for a person', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    const f = fake({ routes: { normal: 'unrouted', sensitive: 'unrouted' } })
    expect(await run(id, f)).toEqual({ ran: false, reason: 'no source to ask' })
    expect(f.fetched).toEqual([])

    const person = (
      await resolveEntity({
        kind: 'person',
        name: 'Asha',
        source: { class: 'manual' },
      })
    ).entityId
    const g = fake()
    expect(await run(person, g)).toEqual({
      ran: false,
      reason: 'no source to ask',
    })
    expect(g.fetched).toEqual([])
  })

  it('a company with no domain ends the source with its reason', async () => {
    const id = await company(null)
    const f = fake()
    expect(await run(id, f)).toEqual({
      ran: false,
      reason: 'no domain to read',
    })
    expect(f.calls).toEqual([])
  })
})

describe('a sensitive record', () => {
  it('with Extract cloud-routed: the Website is skipped, and the timeline says so', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    await sensitive(id)
    const f = fake({ routes: { normal: 'cloud', sensitive: 'cloud' } })
    expect(await run(id, f)).toMatchObject({ ran: true, fields: 0 })
    expect(f.fetched).toEqual([])
    expect(f.calls).toEqual([])
    expect(await lineOf(id)).toEqual(['Website skipped · sensitive'])
    const [receipt] = await websiteReceipts(id)
    expect(receipt.raw['sources']).toEqual([
      expect.objectContaining({ name: 'Website', line: 'sensitive' }),
    ])
  })

  it('with a local route: the Website reads, at sensitive', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    await sensitive(id)
    const f = fake({ routes: { normal: 'cloud', sensitive: 'local' } })
    expect(await run(id, f)).toMatchObject({ ran: true, fields: 2 })
    expect(f.calls.map((c) => c.sensitivity.sensitivity)).toEqual(['sensitive'])
  })

  it('refused by the call itself: skipped as sensitive all the same', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    const f = fake({ refusal: 'SensitiveRouteRefused' })
    expect(await run(id, f)).toMatchObject({ ran: true, fields: 0 })
    expect(await lineOf(id)).toEqual(['Website skipped · sensitive'])
  })
})
