import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { enrichmentRecord, integration } from '@spaces/db/schema'
import { EnrichmentSources } from '@spaces/core/enrichment/sources'
import type { AskInput } from '@spaces/core/enrichment/sources'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { EnrichmentSourcesLive } from './enrichment-sources'
import type { JobInput, PluginHost } from './host'
import type { LoadedPlugin } from './loader'

/**
 * The worker's EnrichmentSources over a stand-in host: the enrich action
 * for the kind is invoked with the keys still wanted, behind the credit
 * guard, whose cache window the workspace's reuse days override.
 */

const manifest = toManifestJson(
  defineManifest({
    manifestVersion: 1,
    id: 'source',
    version: '0.1.0',
    sdk: '^1.3',
    name: 'Source',
    description: 'A source.',
    settings: z.object({ cacheDays: z.int().default(90) }),
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
)

const install = async () => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'source', version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const hostFor = (plugin: LoadedPlugin | null) => {
  const invoked: Array<{ job: string; input: JobInput }> = []
  const unused = () => Effect.die(new Error('not used'))
  const host: PluginHost = {
    wire: unused,
    release: unused,
    releasePlugin: unused,
    releaseAll: unused,
    shutdown: () => Effect.void,
    invoke: (_, job, input) =>
      Effect.sync(() => {
        invoked.push({ job, input })
      }),
    granted: () => null,
    loaded: () => plugin,
    breakerFor: () => null,
  }
  return { host, invoked }
}

const loaded = (row: Awaited<ReturnType<typeof install>>): LoadedPlugin => ({
  integrationId: row.id,
  row,
  manifest,
  settings: z.object({}),
  jobs: { enrichCompany: () => Effect.void },
  fingerprint: 'f',
})

const ask = (host: PluginHost, integrationId: string, input: AskInput) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* EnrichmentSources).ask(integrationId, input)
    }).pipe(Effect.provide(EnrichmentSourcesLive(host))),
  )

const company = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Asked ${Date.now()}`,
      source: { class: 'manual' },
    })
  ).entityId

describe('EnrichmentSourcesLive', () => {
  it('invokes the enrich action for the kind with the keys still wanted', async () => {
    const row = await install()
    const { host, invoked } = hostFor(loaded(row))
    const entityId = await company()
    const keys = ['company.headcount']
    expect(
      await ask(host, row.id, {
        entityId,
        kind: 'company',
        keys,
        reuseDays: null,
      }),
    ).toEqual({ asked: true })
    expect(invoked).toEqual([
      { job: 'enrichCompany', input: { entityId, keys } },
    ])
  })

  it('declines a source that is not loaded or has no action for the kind', async () => {
    const row = await install()
    const entityId = await company()
    const input: AskInput = {
      entityId,
      kind: 'person',
      keys: [],
      reuseDays: null,
    }
    expect(await ask(hostFor(null).host, row.id, input)).toEqual({
      asked: false,
      reason: 'not loaded',
    })
    expect(await ask(hostFor(loaded(row)).host, row.id, input)).toEqual({
      asked: false,
      reason: 'no enrich action for person',
    })
  })

  it('reuses a receipt younger than the workspace’s reuse window, and asks past it', async () => {
    const row = await install()
    const entityId = await company()
    await db.insert(enrichmentRecord).values({
      entityId,
      provider: 'source',
      raw: {},
      integrationId: row.id,
      fetchedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    })
    const { host, invoked } = hostFor(loaded(row))
    const input = (reuseDays: number): AskInput => ({
      entityId,
      kind: 'company',
      keys: ['company.headcount'],
      reuseDays,
    })
    expect(await ask(host, row.id, input(7))).toMatchObject({
      asked: false,
      reason: expect.stringContaining('cached'),
    })
    expect(await ask(host, row.id, input(1))).toEqual({ asked: true })
    expect(invoked).toHaveLength(1)
  })
})
