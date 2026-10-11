import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { aiUsage, enrichmentRecord, entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { user } from '@spaces/db/schema/auth'
import { EnrichmentSources } from '../../enrichment/sources'
import { WebsiteReader } from '../../enrichment/website'
import type { ExtractRoute, FetchedPage } from '../../enrichment/website'
import { jsonRecord } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import { createAttributeProgram } from '../attributes/create'
import { updateAttributeProgram } from '../attributes/update'
import { resolveEntity } from '../entities/resolve'
import { ModelCall, ModelCallRefused } from '../ports/ai'
import type { ModelCallInput } from '../ports/ai'
import { ENRICHMENT_CAPABILITY } from './apply'
import { runEnrichment } from './run'

/**
 * The built-in Website inside a run, over a fake reader and model: its two
 * halves, where it sits in the order, and what a sensitive record lets it
 * do. The guarded fetch and the real model call are the worker's test.
 * (D76, D80)
 */

const HOME = `<html><head><title>Keyhold</title></head><body>
  <p>Keyhold runs key handover for rental homes.</p>
  <a href="https://www.linkedin.com/company/keyhold">LinkedIn</a>
</body></html>`

type Fake = {
  routes: { normal: ExtractRoute; sensitive: ExtractRoute }
  page: FetchedPage
  /** Answers by URL ahead of `page`: an icon, an about page. */
  served?: { readonly [url: string]: FetchedPage }
  /** What the model answers, over the default. */
  answer?: Partial<{ [field: string]: string }>
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
            return f.served?.[url] ?? f.page
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
                    ...f.answer,
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
  it('reads the markup, then the Extract lane for what it left empty', async () => {
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
    expect(await lineOf(id)).toEqual([
      'Enriched · Website (markup + model) · 2 fields',
    ])
  })

  it('is absent for a person', async () => {
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
      parked: null,
    })
    expect(g.fetched).toEqual([])
  })

  it('a company with no domain ends the source with its reason', async () => {
    const id = await company(null)
    const f = fake()
    expect(await run(id, f)).toEqual({
      ran: false,
      reason: 'no domain to read',
      parked: null,
    })
    expect(f.calls).toEqual([])
  })
})

describe('the markup half', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const html = (body: string): FetchedPage => ({
    ok: true,
    url: 'https://keyhold.example/',
    contentType: 'text/html',
    bytes: new TextEncoder().encode(body),
  })
  const icon = (tag: string): FetchedPage => ({
    ok: true,
    url: 'https://keyhold.example/touch.png',
    contentType: 'image/png',
    bytes: new Uint8Array([...PNG, ...new TextEncoder().encode(tag)]),
  })
  const RICH = `<!doctype html><html><head>
    <title>Keyhold — Key handover for rental homes</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/touch.png">
    <meta property="og:image" content="/share.png">
  </head><body>
    <a href="https://twitter.com/intent/tweet?text=hi">Share</a>
    <a href="https://www.linkedin.com/company/keyhold/">LinkedIn</a>
    <a href="https://x.com/keyhold">X</a>
  </body></html>`

  // The owner links their own attribute to `company.twitter`.
  let twitter = ''
  beforeAll(async () => {
    const createdBy = (await db.select({ id: user.id }).from(user).limit(1)).at(
      0,
    )?.id
    if (createdBy === undefined) throw new Error('no fixture user')
    const created = await Effect.runPromise(
      createAttributeProgram({
        objectKind: 'company',
        name: 'Twitter',
        type: 'url',
        createdBy,
      }),
    )
    await Effect.runPromise(
      updateAttributeProgram({
        id: created.id,
        config: { enrichmentKey: 'company.twitter' },
      }),
    )
    twitter = created.slug
  })

  it('with no model routed fills the title, the logo and the links, and writes no ai_usage', async () => {
    const domain = `k${String(n + 1)}.example`
    const id = await company(domain)
    const f = fake({
      routes: { normal: 'unrouted', sensitive: 'unrouted' },
      page: html(RICH),
      served: { 'https://keyhold.example/touch.png': icon(domain) },
    })
    expect(await run(id, f)).toMatchObject({
      ran: true,
      fields: 3,
      credits: 0,
      picture: 'set',
    })
    expect(f.fetched).toEqual([
      `https://${domain}/`,
      'https://keyhold.example/touch.png',
    ])
    expect(f.calls).toEqual([])
    expect(await db.select({ id: aiUsage.id }).from(aiUsage)).toEqual([])
    const values = await valuesOf(id)
    expect(values['description']).toBe('Key handover for rental homes')
    expect(values['linkedin']).toBe('https://www.linkedin.com/company/keyhold/')
    expect(values[twitter]).toBe('https://x.com/keyhold')
    expect(await lineOf(id)).toEqual([
      'Enriched · Website (markup) · 3 fields · logo',
    ])
    const receipt = (await websiteReceipts(id)).find(
      (r) => r.raw['source'] === 'website',
    )
    expect(receipt?.credits).toBe(0)
    expect(receipt?.raw['title']).toBe(
      'Keyhold — Key handover for rental homes',
    )
  })

  it('with a model routed runs both halves; the model fills only what the markup left empty', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    const f = fake({
      page: html(`<html><head><title>Keyhold</title>
        <meta name="description" content="Keys for property managers.">
      </head><body>
        <a href="https://www.linkedin.com/company/keyhold">LinkedIn</a>
        <p>Keyhold is based in Bengaluru.</p>
      </body></html>`),
      answer: {
        description: 'Keyhold runs key handover for rental homes.',
        location: 'Bengaluru, India',
        linkedin: 'https://www.linkedin.com/company/keyhold',
      },
    })
    expect(await run(id, f)).toMatchObject({ ran: true, fields: 3 })
    expect(f.calls).toHaveLength(1)
    const values = await valuesOf(id)
    expect(values['description']).toBe('Keys for property managers.')
    expect(values['location']).toBe('Bengaluru, India')
    expect(values['linkedin']).toBe('https://www.linkedin.com/company/keyhold')
    expect(await lineOf(id)).toEqual([
      'Enriched · Website (markup + model) · 3 fields',
    ])
    const raw = (await websiteReceipts(id))
      .map((r) => r.raw)
      .find((r) => r['source'] === 'website')
    expect(raw?.['markup']).toMatchObject({
      'company.description': 'Keys for property managers.',
    })
  })
})

describe('a sensitive record', () => {
  it('with Extract cloud-routed: the markup half reads, the model half is skipped and the timeline says so', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    await sensitive(id)
    const f = fake({ routes: { normal: 'cloud', sensitive: 'cloud' } })
    expect(await run(id, f)).toMatchObject({ ran: true, fields: 1 })
    expect(f.fetched).toEqual([`https://k${String(n)}.example/`])
    expect(f.calls).toEqual([])
    expect(await lineOf(id)).toEqual([
      'Enriched · Website (markup) · 1 field · Website (model) skipped · sensitive',
    ])
    const run_ = (await websiteReceipts(id))
      .map((r) => r.raw)
      .find((r) => r['run'] === 'enrichment')
    expect(run_?.['sources']).toEqual([
      expect.objectContaining({
        name: 'Website (markup)',
        notes: [{ name: 'Website (model)', why: 'sensitive' }],
      }),
    ])
  })

  it('with a local route: both halves read, at sensitive', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    await sensitive(id)
    const f = fake({ routes: { normal: 'cloud', sensitive: 'local' } })
    expect(await run(id, f)).toMatchObject({ ran: true, fields: 2 })
    expect(f.calls.map((c) => c.sensitivity.sensitivity)).toEqual(['sensitive'])
  })

  it('refused by the call itself: the model half is skipped as sensitive all the same', async () => {
    const id = await company(`k${String(n + 1)}.example`)
    const f = fake({ refusal: 'SensitiveRouteRefused' })
    expect(await run(id, f)).toMatchObject({ ran: true, fields: 1 })
    expect(await lineOf(id)).toEqual([
      'Enriched · Website (markup) · 1 field · Website (model) skipped · sensitive',
    ])
  })
})
