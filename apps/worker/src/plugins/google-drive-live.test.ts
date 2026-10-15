import { randomUUID } from 'node:crypto'
import { Cause, Context, Effect, Exit, Layer, Option, Redacted } from 'effect'
import { isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { Http, Secrets } from '@spaces/sdk'
import { DRIVE_API } from '@spaces/sdk/testing'
import { pluginsRootWith } from './fakes/enrichers'
import { cassetteProviders } from './fakes/registry'
import { grantLayer } from './grant'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'

/**
 * Google Drive under `SPACES_FAKE_PROVIDERS=1`: the real bundle, loaded as
 * boot loads it, with no connection on its row — the stand-in hands it the
 * fake Drive API as its transport and a fake access token — and its list
 * job walking the seeded data room. Off, the same row degrades with
 * "missing connection" and Secrets has no token to give.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

beforeEach(async () => {
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

const insertRow = async (config: { folderId: string }) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'google-drive',
        version: '0.1.0',
        enabled: true,
        config,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

describe('google-drive with the fakes on', () => {
  it('loads with no connection and lists the seeded data room with paths', async () => {
    const root = pluginsRootWith('google-drive', ['google-drive'])
    const row = await insertRow({ folderId: 'dataroom' })
    const fakes = cassetteProviders()
    const { loaded, verdicts } = await Effect.runPromise(
      reconcilePlugins({ pluginsRoot: root, only: 'google-drive', fakes }),
    )
    expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['google-drive', 'enabled', null],
    ])
    const lines: Array<string> = []
    const host = makePluginHost({
      enqueue: NoEnqueue,
      fakes,
      sink: (_, line) => void lines.push(line),
    })
    hosts.push(host)
    await Effect.runPromise(host.wire(loaded))
    const exit = await Effect.runPromiseExit(
      host.invoke(row.id, 'list', { cursor: null }),
    )
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(exit.value).toEqual({ nextCursor: null })
    const paths = lines
      .filter((l) => l.startsWith('[plugin:google-drive] entry '))
      .map(
        (l) =>
          z
            .object({ path: z.string() })
            .parse(JSON.parse(l.slice('[plugin:google-drive] entry '.length)))
            .path,
      )
    expect(paths).toContain(
      'My Drive/Acme Data Room/02 Finance/Board/Minutes Q3.pdf',
    )
    expect(paths).toHaveLength(17)
    // Every request went to the fake, with the fake's token.
    const api = fakes.api('google-drive')
    expect(api?.requests.length).toBeGreaterThan(0)
    expect(api?.requests.every((r) => r.url.startsWith(DRIVE_API))).toBe(true)
  })

  it('the grant hands the fake access token; off, there is none', async () => {
    const boundRow = {
      id: randomUUID(),
      capabilityId: 'google-drive',
      config: {},
      credentialId: null,
      connectionId: null,
    }
    const secretsOf = async (
      fakes: ReturnType<typeof cassetteProviders> | null,
    ) => {
      const context = await Effect.runPromise(
        Effect.scoped(
          Layer.build(
            grantLayer(boundRow, ['Http', 'Secrets'], {
              settings: z.object({}),
              enqueue: NoEnqueue,
              fakes,
            }),
          ),
        ),
      )
      return {
        secrets: Option.getOrThrow(Context.getOption(context, Secrets)),
        http: Option.getOrThrow(Context.getOption(context, Http)),
      }
    }
    const fakes = cassetteProviders()
    const on = await secretsOf(fakes)
    const token = await Effect.runPromise(on.secrets.accessToken())
    expect(Redacted.value(token)).toBe(fakes.api('google-drive')?.accessToken)
    const list = await Effect.runPromise(
      on.http.request({
        method: 'GET',
        url: `${DRIVE_API}/files/dataroom?fields=id,name`,
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
      }),
    )
    expect(JSON.parse(list.body)).toEqual({
      id: 'dataroom',
      name: 'Acme Data Room',
    })

    const off = await secretsOf(null)
    const refused = await Effect.runPromiseExit(off.secrets.accessToken())
    expect(Exit.isFailure(refused)).toBe(true)
  })
})

describe('google-drive with the fakes off', () => {
  it('degrades with “missing connection”', async () => {
    const root = pluginsRootWith('google-drive-off', ['google-drive'])
    await insertRow({ folderId: 'dataroom' })
    const { verdicts } = await Effect.runPromise(
      reconcilePlugins({
        pluginsRoot: root,
        only: 'google-drive',
        fakes: null,
      }),
    )
    expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['google-drive', 'degraded', 'missing connection'],
    ])
  })

  it('stands in for nothing outside a workspace', () => {
    expect(cassetteProviders(null).standIn('google-drive')).toBeNull()
  })
})
