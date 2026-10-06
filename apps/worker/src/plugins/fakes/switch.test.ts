import { randomUUID } from 'node:crypto'
import { Context, Effect, Exit, Layer, Option, Redacted } from 'effect'
import { isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import type { BoundIntegration } from '@spaces/core/writes/ports/binding'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import { storeCredential } from '@spaces/core/writes/vault'
import { Http, Secrets } from '@spaces/sdk'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { grantLayer } from '../grant'
import { makePluginHost } from '../host'
import { reconcilePlugins } from '../loader'
import type { ReconcileOptions } from '../loader'
import { makePluginReloader } from '../reload'
import { pluginsRootWith } from './enrichers'
import { cassetteProviders, fakeKeyFor } from './registry'

/**
 * Where `SPACES_FAKE_PROVIDERS` takes effect: the grant swaps a faked
 * plugin's Http transport and, for an unkeyed row, its Secrets; the loader
 * lets that row past `requires.credential`. Off (no fakes), both are
 * exactly the live path — the request reaches the live `fetch`.
 */

const ORG_URL =
  'https://api.apollo.io/api/v1/organizations/enrich?domain=northwind-robotics.example'

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** The live transport: records the URL and answers something no cassette holds. */
const liveTransport = () => {
  const urls: Array<string> = []
  const fetch: FetchLike = (url) => {
    urls.push(url)
    return Promise.resolve(new Response('{"from":"live"}', { status: 200 }))
  }
  return { urls, fetch }
}

const boundRow = (
  capabilityId: string,
  credentialId: string | null = null,
): BoundIntegration => ({
  id: randomUUID(),
  capabilityId,
  config: {},
  credentialId,
})

/** The Http and Secrets a grant of `['Http', 'Secrets']` hands the job. */
const granted = async (
  row: BoundIntegration,
  fetch: FetchLike,
  fakes: ReturnType<typeof cassetteProviders> | null,
) => {
  const context = await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        grantLayer(row, ['Http', 'Secrets'], {
          settings: z.object({}),
          enqueue: noEnqueue,
          fetch,
          fakes,
        }),
      ),
    ),
  )
  return {
    http: Option.getOrThrow(Context.getOption(context, Http)),
    secrets: Option.getOrThrow(Context.getOption(context, Secrets)),
  }
}

const post = (http: Http['Service']) =>
  Effect.runPromise(http.request({ method: 'POST', url: ORG_URL }))

describe('the grant', () => {
  it('flag off: the request reaches the live transport and an unkeyed row has no key', async () => {
    const live = liveTransport()
    const { http, secrets } = await granted(
      boundRow('apollo'),
      live.fetch,
      null,
    )
    expect((await post(http)).body).toBe('{"from":"live"}')
    expect(live.urls).toEqual([ORG_URL])
    const key = await Effect.runPromiseExit(secrets.get())
    expect(Exit.isFailure(key)).toBe(true)
  })

  it('flag on: the cassette answers, nothing reaches the live transport, and Secrets hands out the fake key', async () => {
    const live = liveTransport()
    const { http, secrets } = await granted(
      boundRow('apollo'),
      live.fetch,
      cassetteProviders(),
    )
    const response = await post(http)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      organization: { name: 'Northwind Robotics' },
    })
    expect(live.urls).toEqual([])
    expect(Redacted.value(await Effect.runPromise(secrets.get()))).toBe(
      fakeKeyFor('apollo'),
    )
  })

  it('flag on: a plugin with no cassette stays on the live transport', async () => {
    const live = liveTransport()
    const { http } = await granted(
      boundRow('rss'),
      live.fetch,
      cassetteProviders(),
    )
    await post(http)
    expect(live.urls).toEqual([ORG_URL])
  })

  it('flag on: a row with its own credential keeps it; only the transport is faked', async () => {
    const stored = await storeCredential({
      scope: 'workspace',
      provider: 'apollo',
      kind: 'enrichment',
      secret: 'apollo-bound-key-123456',
      createdBy: FIXTURE_ACTOR.id,
    })
    const live = liveTransport()
    const fakes = cassetteProviders()
    const { http, secrets } = await granted(
      boundRow('apollo', stored.id),
      live.fetch,
      fakes,
    )
    expect(Redacted.value(await Effect.runPromise(secrets.get()))).toBe(
      'apollo-bound-key-123456',
    )
    await post(http)
    expect(live.urls).toEqual([])
    expect(fakes.provider('apollo')?.requests).toHaveLength(1)
  })
})

describe('the loader’s credential check', () => {
  // Each test's row is the only enabled one.
  beforeEach(async () => {
    await db
      .update(integration)
      .set({ enabled: false })
      .where(isNotNull(integration.id))
  })

  const insertRow = async (capabilityId: string) => {
    const row = (
      await db
        .insert(integration)
        .values({ capabilityId, version: '0.1.0', enabled: true })
        .returning()
    ).at(0)
    if (!row) throw new Error('no row')
    return row
  }

  const verdictOf = async (
    root: string,
    only: string,
    fakes: ReturnType<typeof cassetteProviders> | null,
  ) =>
    (
      await Effect.runPromise(
        reconcilePlugins({ pluginsRoot: root, only, fakes }),
      )
    ).verdicts.map((v) => [v.id, v.status, v.reason])

  it('flag off: an unkeyed Apollo degrades with “missing credential”', async () => {
    const root = pluginsRootWith('switch-off', ['apollo'])
    await insertRow('apollo')
    expect(await verdictOf(root, 'apollo', null)).toEqual([
      ['apollo', 'degraded', 'missing credential'],
    ])
  })

  it('flag on: the same row loads, because the fake hands it a key', async () => {
    const root = pluginsRootWith('switch-on', ['apollo'])
    await insertRow('apollo')
    expect(await verdictOf(root, 'apollo', cassetteProviders())).toEqual([
      ['apollo', 'enabled', null],
    ])
  })

  it('flag on: a plugin no fake stands in for still needs its credential', async () => {
    const root = pluginsRootWith('switch-needs-key', ['_fixtures/needs-key'])
    await insertRow('needs-key')
    expect(await verdictOf(root, 'needs-key', cassetteProviders())).toEqual([
      ['needs-key', 'degraded', 'missing credential'],
    ])
  })
})

describe('the reloader', () => {
  it('hands the fakes to every reconcile, boot’s and plugin_changed’s alike', async () => {
    const fakes = cassetteProviders()
    const seen: Array<ReconcileOptions> = []
    const reloader = makePluginReloader({
      host: makePluginHost({ enqueue: noEnqueue }),
      fakes,
      debounceMs: 0,
      log: () => undefined,
      reconcile: (options) => {
        seen.push(options)
        return Effect.succeed({ verdicts: [], loaded: [] })
      },
    })
    reloader.request(null)
    reloader.request('apollo')
    await Effect.runPromise(reloader.settled())
    expect(seen.map((o) => [o.only ?? null, o.fakes === fakes])).toEqual([
      ['apollo', true],
      [null, true],
    ])
  })
})
