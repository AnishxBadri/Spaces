import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { setValues } from '@spaces/core/writes/attributes/values'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { storeCredential } from '@spaces/core/writes/vault'
import { ENRICHMENT_CAPABILITY } from '@spaces/core/writes/enrichment/apply'
import { jsonRecord } from '@spaces/core/json'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { ENRICHERS, pluginsRootWith } from '../fakes/enrichers'
import type { Enricher } from '../fakes/enrichers'
import { cassetteProviders } from '../fakes/registry'
import { makePluginHost } from '../host'
import type { PluginHost } from '../host'
import { reconcilePlugins } from '../loader'
import { pluginQueues } from '../queues'

/**
 * What every enricher must do to ship, run once per entry in `ENRICHERS`
 * against its provider fake on the live ports. A new enricher is one more
 * entry and runs every case here.
 *
 * The real bundle, loaded and wired as boot does it; jobs run through the
 * host's `invoke`, the queue being the chaos suite's business.
 */

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the conformance suite must not reach the network')
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []
const logged: Array<string> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  logged.splice(0)
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

const KEY = 'conformance-key-0123456789abcdef'

/** The enricher keyed, loaded and wired with its fake standing in for the provider. */
const wire = async (enricher: Enricher) => {
  const root = pluginsRootWith('conformance', [enricher.id])
  const stored = await storeCredential({
    scope: 'workspace',
    provider: enricher.id,
    kind: 'enrichment',
    secret: KEY,
    createdBy: FIXTURE_ACTOR.id,
  })
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: enricher.id,
        version: '0.1.0',
        enabled: true,
        credentialId: stored.id,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  const fakes = cassetteProviders()
  const fake = fakes.provider(enricher.id)
  if (fake === null) throw new Error(`${enricher.id} has no cassette`)
  const host = makePluginHost({
    enqueue: noEnqueue,
    fakes,
    sink: (_level, line) => {
      logged.push(line)
    },
  })
  hosts.push(host)
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: enricher.id }),
  )
  await Effect.runPromise(host.wire(loaded))
  const plugin = loaded.at(0)
  if (!plugin) throw new Error(`${enricher.id} did not load`)
  const enrich = (entityId: string) =>
    Effect.runPromiseExit(
      host.invoke(row.id, enricher.companyJob, { entityId }),
    )
  return { row, fake, plugin, enrich }
}

const seedCompany = async (name: string, domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId

const valuesOf = async (entityId: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)?.values ?? {}

const receiptsOf = (entityId: string) =>
  db
    .select()
    .from(enrichmentRecord)
    .where(eq(enrichmentRecord.entityId, entityId))

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Cause.findErrorOption(exit.cause))?._tag
    : null

describe.each(ENRICHERS)('enricher $id', (enricher) => {
  const { matched, unmatched } = enricher

  it('a match: one receipt from the bound integration, then the blank values filled', async () => {
    const { row, enrich } = await wire(enricher)
    const companyId = await seedCompany(matched.name, matched.domain)

    expect((await enrich(companyId))._tag).toBe('Success')

    // The provider's receipt, and beside it the host's receipt of the run
    // its answers were applied in.
    const all = await receiptsOf(companyId)
    const receipts = all.filter((r) => r.provider !== ENRICHMENT_CAPABILITY)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ integrationId: row.id })
    expect(receipts[0]?.creditsUsed).toBeGreaterThan(0)
    expect(
      all.filter((r) => r.provider === ENRICHMENT_CAPABILITY),
    ).toHaveLength(1)
    expect(await valuesOf(companyId)).toMatchObject(matched.values)
  })

  it('an answer no attribute links is kept in the run’s receipt and written nowhere', async () => {
    const { enrich } = await wire(enricher)
    const companyId = await seedCompany(matched.name, matched.domain)

    expect((await enrich(companyId))._tag).toBe('Success')
    const run = (await receiptsOf(companyId)).find(
      (r) => r.provider === ENRICHMENT_CAPABILITY,
    )
    const raw = jsonRecord(run?.raw)
    const held = Array.isArray(raw.unlinked) ? raw.unlinked.map(jsonRecord) : []
    expect(held.map((a) => a.key).sort()).toEqual([...matched.unlinked])
    const values = JSON.stringify(await valuesOf(companyId))
    for (const answer of held)
      expect(values).not.toContain(JSON.stringify(answer.value))
  })

  it('a value a person set is never overwritten', async () => {
    const { enrich } = await wire(enricher)
    const companyId = await seedCompany(matched.name, matched.domain)
    const slug = Object.keys(matched.values).at(0)
    if (slug === undefined) throw new Error('the entry fills no value')
    const human = slug === 'founded_year' ? 1901 : 'Set by a person.'
    await setValues({
      entityId: companyId,
      patch: { [slug]: human },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })

    expect((await enrich(companyId))._tag).toBe('Success')
    expect((await valuesOf(companyId))[slug]).toEqual(human)
  })

  it('no match: a receipt that spent nothing, and no value written', async () => {
    const { enrich } = await wire(enricher)
    const companyId = await seedCompany(unmatched.name, unmatched.domain)

    expect((await enrich(companyId))._tag).toBe('Success')
    const receipts = await receiptsOf(companyId)
    expect(receipts.map((r) => r.creditsUsed ?? 0)).toEqual([0])
    for (const slug of Object.keys(matched.values))
      expect(await valuesOf(companyId)).not.toHaveProperty(slug)
  })

  it('the provider failing: 5xx is retryable, any other refusal permanent, and neither writes', async () => {
    const { fake, enrich } = await wire(enricher)
    const flaky = await seedCompany('Flaky Co', 'flaky.example')
    const refused = await seedCompany('Refused Co', 'refused.example')
    fake.failWhere(enricher.asksAbout('flaky.example'), 503)
    fake.failWhere(enricher.asksAbout('refused.example'), 403)

    expect(failureTag(await enrich(flaky))).toBe('JobRetryable')
    expect(failureTag(await enrich(refused))).toBe('JobPermanent')
    expect(await receiptsOf(flaky)).toEqual([])
    expect(await receiptsOf(refused)).toEqual([])
  })

  it('sends its key to the provider and never writes it to a log line', async () => {
    const { fake, enrich } = await wire(enricher)
    const companyId = await seedCompany(matched.name, matched.domain)
    await enrich(companyId)
    expect(fake.requests.map((r) => r.key)).toEqual([KEY])
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.join('\n')).not.toContain(KEY)
  })

  it('declares what an enrichment costs, per record asked about', async () => {
    const { plugin } = await wire(enricher)
    const plan = pluginQueues(plugin.manifest, plugin.jobs).find(
      (p) => p.job === enricher.companyJob,
    )
    const one = plan?.cost?.({ entityIds: ['a'] }).credits ?? 0
    expect(one).toBeGreaterThan(0)
    expect(plan?.cost?.({ entityIds: ['a', 'b', 'c'] }).credits).toBe(3 * one)
  })
})
