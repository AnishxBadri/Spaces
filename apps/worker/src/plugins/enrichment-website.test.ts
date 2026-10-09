import { createHash } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, isNotNull } from 'drizzle-orm'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  aiRoute,
  aiUsage,
  credential,
  enrichmentRecord,
  entity,
  integration,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { EnrichmentSources } from '@spaces/core/enrichment/sources'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { updateAttributeProgram } from '@spaces/core/writes/attributes/update'
import { ENRICHMENT_CAPABILITY } from '@spaces/core/writes/enrichment/apply'
import { runEnrichment } from '@spaces/core/writes/enrichment/run'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { storage } from '@spaces/core/writes/storage'
import { storeCredential } from '@spaces/core/writes/vault'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { setAiRouteProgram } from '#web/lib/ai/route'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { WebsiteReaderLive } from '../jobs/enrichment-run'
import { ModelCallLive } from './model-call'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * The built-in Website end to end (D76): a fixture site served from memory
 * through the URL guard with `fetch` stubbed (no sockets), the Extract lane
 * through `complete()` on an injected model, and a stand-in paid source
 * after it that must still be asked when the Website fails.
 */

const HOME = `<!doctype html><html><head>
  <title>Keyhold</title>
  <meta name="description" content="Keyhold runs key handover for rental homes.">
</head><body>
  <img class="site-logo" src="/logo.png" alt="Keyhold">
  <h1>Key handover, done.</h1>
  <a href="/about">About</a>
  <a href="https://www.linkedin.com/company/keyhold">LinkedIn</a>
  <a href="https://x.com/keyhold">X</a>
  <a href="https://www.crunchbase.com/organization/keyhold">Crunchbase</a>
  <a href="/blog">Blog</a>
</body></html>`

const ABOUT = `<!doctype html><html><body>
  <h1>About Keyhold</h1><p>We are based in Bengaluru, India.</p>
</body></html>`

const EXTRACTED = {
  description: 'Keyhold runs key handover for rental homes.',
  location: 'Bengaluru, India',
  linkedin: 'https://www.linkedin.com/company/keyhold',
  twitter: 'https://x.com/keyhold',
  crunchbase: 'https://www.crunchbase.com/organization/keyhold',
  blog: 'https://keyhold.example/blog',
  logo: 'https://keyhold.example/logo.png',
}

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

/** A PNG's signature and a tag: enough for the host to take it as one. */
const LOGO = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new TextEncoder().encode('keyhold'),
])

/** The fixture sites, by URL; anything else is unreachable. */
const SITES = new Map<string, () => Response>([
  ['https://keyhold.example/', () => html(HOME)],
  [
    'https://keyhold.example/logo.png',
    () => new Response(LOGO, { headers: { 'content-type': 'image/png' } }),
  ],
  ['https://keyhold.example/about', () => html(ABOUT)],
  ['https://gone.example/', () => html('<p>Not here</p>', 404)],
  ['https://huge.example/', () => html(`<p>${'x'.repeat(4000)}</p>`)],
])

const fetched: Array<string> = []

const stubSites = () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      fetched.push(url)
      const site = SITES.get(url)
      return site === undefined
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(site())
    }),
  )
}

const mockModel = () =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(EXTRACTED) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 120,
            noCache: 120,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 30, text: 30, reasoning: undefined },
        },
        warnings: [],
      }),
  })

const routeExtract = async () => {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-spaces-website',
    meta: {},
    createdBy: FIXTURE_ACTOR.id,
  })
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

/** A paid source after the Website: logs what it is asked, answers nothing. */
const asked: Array<ReadonlyArray<string>> = []
const PaidSource = Layer.succeed(
  EnrichmentSources,
  EnrichmentSources.of({
    ask: (_, input) =>
      Effect.sync(() => {
        asked.push(input.keys)
        return { asked: true } as const
      }),
  }),
)

const installPaidSource = async () => {
  const manifest = jsonRecord(
    jsonValue.parse(
      toManifestJson(
        defineManifest({
          manifestVersion: 1,
          id: 'paid',
          version: '0.1.0',
          sdk: '^1.3',
          name: 'Paid',
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
  await db.insert(integration).values({
    capabilityId: 'paid',
    version: '0.1.0',
    enabled: true,
    status: 'enabled',
    manifest,
  })
}

const run = (entityId: string, model: MockLanguageModelV4, maxBytes?: number) =>
  Effect.runPromise(
    runEnrichment(entityId, 'test').pipe(
      Effect.provide(
        Layer.mergeAll(
          PaidSource,
          Layer.succeed(
            Enqueue,
            Enqueue.of({ enqueue: () => Effect.succeed(null) }),
          ),
          WebsiteReaderLive(maxBytes === undefined ? {} : { maxBytes }),
          ModelCallLive({ model }),
        ),
      ),
    ),
  )

let n = 0
const company = async (domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Keyhold ${String(++n)}`,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId

const receipts = async (entityId: string) =>
  (
    await db
      .select({
        raw: enrichmentRecord.raw,
        credits: enrichmentRecord.creditsUsed,
      })
      .from(enrichmentRecord)
      .where(
        and(
          eq(enrichmentRecord.entityId, entityId),
          eq(enrichmentRecord.provider, ENRICHMENT_CAPABILITY),
        ),
      )
  ).map((r) => ({ raw: jsonRecord(r.raw), credits: r.credits }))

const runReceipt = async (entityId: string) =>
  (await receipts(entityId)).find((r) => r.raw['run'] === 'enrichment')?.raw

beforeAll(async () => {
  const twitter = await Effect.runPromise(
    createAttributeProgram({
      objectKind: 'company',
      name: 'Twitter',
      type: 'url',
      createdBy: FIXTURE_ACTOR.id,
    }),
  )
  await Effect.runPromise(
    updateAttributeProgram({
      id: twitter.id,
      config: { enrichmentKey: 'company.twitter' },
    }),
  )
  await installPaidSource()
})

beforeEach(async () => {
  fetched.length = 0
  asked.length = 0
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
  await routeExtract()
  stubSites()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Website against a fixture site', () => {
  it('answers description, links and location, which fill the linked attributes', async () => {
    const id = await company('keyhold.example')
    const model = mockModel()
    const outcome = await run(id, model)

    expect(fetched).toEqual([
      'https://keyhold.example/',
      'https://keyhold.example/about',
      'https://keyhold.example/logo.png',
    ])
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(outcome).toMatchObject({ ran: true, fields: 4, credits: 0 })
    const values =
      (
        await db
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, id))
      ).at(0)?.values ?? {}
    expect(values).toMatchObject({
      description: EXTRACTED.description,
      location: EXTRACTED.location,
      linkedin: EXTRACTED.linkedin,
      twitter: EXTRACTED.twitter,
    })
    // The paid source after it is asked only for what is still empty.
    expect(asked).toEqual([['company.founded_year']])

    const lines = (
      await db
        .select({ meta: activity.meta })
        .from(activity)
        .where(eq(activity.subjectEntityId, id))
    ).map((r) => jsonRecord(r.meta)['line'])
    expect(lines).toContain('Enriched · Website, Paid · 4 fields · logo')
  })

  it('needs no credential of its own: ai_usage is the Extract lane on the host row, and no credit is counted', async () => {
    const id = await company('keyhold.example')
    await run(id, mockModel())
    const host = (
      await db
        .select({ id: integration.id })
        .from(integration)
        .where(eq(integration.capabilityId, ENRICHMENT_CAPABILITY))
    ).at(0)
    const usage = await db
      .select({
        lane: aiUsage.lane,
        callerType: aiUsage.callerType,
        callerId: aiUsage.callerId,
        tokensIn: aiUsage.tokensIn,
      })
      .from(aiUsage)
      .where(eq(aiUsage.callerId, host?.id ?? ''))
    expect(usage).toEqual([
      {
        lane: 'extract',
        callerType: 'integration',
        callerId: host?.id,
        tokensIn: 120,
      },
    ])
    const website = (await receipts(id)).find(
      (r) => r.raw['source'] === 'website',
    )
    expect(website?.credits).toBe(0)
  })

  it('fetches the logo once and stores it as the record’s picture', async () => {
    const id = await company('keyhold.example')
    await run(id, mockModel())
    const sha = createHash('sha256').update(LOGO).digest('hex')
    const row = (
      await db
        .select({ sha: entity.pictureSha })
        .from(entity)
        .where(eq(entity.id, id))
    ).at(0)
    expect(row?.sha).toBe(sha)
    expect(await storage().exists(sha)).toBe(true)
    const raw = await runReceipt(id)
    expect(raw?.['unlinked']).toEqual([])
    expect(raw?.['picture']).toMatchObject({
      key: 'company.logo',
      url: 'https://keyhold.example/logo.png',
      outcome: 'set',
    })
    await storage().delete(sha)
  })
})

describe('a site that cannot be read ends the Website, and the next source still runs', () => {
  it.each([
    [
      'unreachable',
      'down.example',
      /Could not reach https:\/\/down\.example\//,
    ],
    ['a 404', 'gone.example', /answered 404/],
    ['over the size cap', 'huge.example', /larger than the 1000 byte limit/],
  ])('%s', async (_, domain, reason) => {
    const id = await company(domain)
    const model = mockModel()
    await run(id, model, 1000)
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(asked).toHaveLength(1)
    const raw = await runReceipt(id)
    const sources = Array.isArray(raw?.['sources']) ? raw['sources'] : []
    const website = jsonRecord(sources[0])
    expect(website['name']).toBe('Website')
    expect(String(website['skipped'])).toMatch(reason)
  })
})
