import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  integration,
  storageBinding,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { BOX_API, BOX_DOWNLOAD, makeFakeBoxApi } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pluginBreakerLayer } from './breaker'
import { pluginsRootWith } from './fakes/enrichers'
import { cassetteProviders } from './fakes/registry'
import type { FakeProviders } from './fakes/switch'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { storageSourcesLayer } from './storage-source'
import { JobContext } from '../run-job'
import type { JobFailure, JobResult } from '../run-job'
import { pollStorageChanges } from '../jobs/poll-storage-changes'

/**
 * Box, the second storage source, on its real bundle: under
 * `SPACES_FAKE_PROVIDERS=1` the stand-in hands it the fake Box as its
 * transport, its list job walks the seeded data room, and core's change
 * poll — unchanged, and naming no provider — files a new file from Box's
 * events stream and re-syncs the binding when Box forgets the position.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

beforeEach(async () => {
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
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
      .values({ capabilityId: 'box', version: '0.1.0', enabled: true, config })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

describe('box with the fakes on', () => {
  it('loads with no connection and lists the seeded data room with paths', async () => {
    const root = pluginsRootWith('box', ['box'])
    const row = await insertRow({ folderId: '1001' })
    const fakes = cassetteProviders()
    const { loaded, verdicts } = await Effect.runPromise(
      reconcilePlugins({ pluginsRoot: root, only: 'box', fakes }),
    )
    expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['box', 'enabled', null],
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
      .filter((l) => l.startsWith('[plugin:box] entry '))
      .map(
        (l) =>
          z
            .object({ path: z.string() })
            .parse(JSON.parse(l.slice('[plugin:box] entry '.length))).path,
      )
    expect(paths).toContain(
      'All Files/Acme Data Room/02 Finance/Board/Minutes Q3.pdf',
    )
    expect(paths).toContain('All Files/Acme Data Room/Investment memo.boxnote')
    // Ten files and folders; the web link is not one.
    expect(paths).toHaveLength(10)
    const api = fakes.box('box')
    expect(api?.requests.length).toBeGreaterThan(0)
    expect(api?.requests.every((r) => r.url.startsWith(BOX_API))).toBe(true)
  })
})

describe('box with the fakes off', () => {
  it('degrades with “missing connection”', async () => {
    const root = pluginsRootWith('box-off', ['box'])
    await insertRow({ folderId: '1001' })
    const { verdicts } = await Effect.runPromise(
      reconcilePlugins({ pluginsRoot: root, only: 'box', fakes: null }),
    )
    expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['box', 'degraded', 'missing connection'],
    ])
  })

  it('stands in for nothing outside a workspace', () => {
    expect(cassetteProviders(null).standIn('box')).toBeNull()
  })
})

/** The fake Box wired as the installed Box, with a recording `Enqueue` for the poll. */
const wiredBox = async () => {
  const api = makeFakeBoxApi()
  const root = pluginsRootWith('poll-box', ['box'])
  await insertRow({ folderId: '1001' })
  const fakes: FakeProviders = {
    standIn: (pluginId) =>
      pluginId === 'box'
        ? {
            fetch: api.fetch,
            secret: 'fake-box-key',
            accessToken: api.accessToken,
          }
        : null,
  }
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: 'box', fakes }),
  )
  const host = makePluginHost({ enqueue: NoEnqueue, fakes })
  hosts.push(host)
  await Effect.runPromise(host.wire(loaded))
  const sent: Array<{ queue: string; data: Record<string, unknown> }> = []
  const recording = Layer.succeed(
    Enqueue,
    Enqueue.of({
      enqueue: (queue, data) =>
        Effect.sync(() => {
          sent.push({ queue, data })
          return `job-${String(sent.length)}`
        }),
    }),
  )
  const layer = Layer.mergeAll(
    storageSourcesLayer(host, { fakes, pluginsRoot: root }),
    recording,
    pluginBreakerLayer(host),
  )
  const poll = () =>
    Effect.runPromiseExit(
      pollStorageChanges.run({}).pipe(
        Effect.provide(layer),
        Effect.provideService(
          JobContext,
          JobContext.of({
            queue: QUEUES.pollStorageChanges,
            jobId: `test-${randomUUID()}`,
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
      ),
    )
  return { api, sent, poll }
}

const aBoxConnection = async () => {
  const userId = FIXTURE_ACTOR.id
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'box',
        product: 'box',
        externalEmail: `${randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          {
            accessToken: 'unused',
            refreshToken: 'refresh',
            tokenType: 'bearer',
          },
          { userId, provider: 'box' },
        ),
        scopes: ['root_readonly'],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return row.id
}

const cursorOf = async (connectionId: string) =>
  (
    await db
      .select({ cursor: accountConnection.storageCursor })
      .from(accountConnection)
      .where(eq(accountConnection.id, connectionId))
  ).at(0)?.cursor ?? null

/** Every binding past the poll's minimum interval. */
const age = () =>
  db
    .update(storageBinding)
    .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(storageBinding.id))

describe('storage.poll on the box bundle', () => {
  it('files a new file from the events stream, and an expired stream position re-syncs the binding', async () => {
    const box = await wiredBox()
    const connectionId = await aBoxConnection()
    const deal = (
      await db
        .insert(entity)
        .values({ kind: 'deal', canonicalName: 'Acme legal' })
        .returning({ id: entity.id })
    ).at(0)
    if (deal === undefined) throw new Error('no record')
    const binding = (
      await Effect.runPromise(
        bindFolderProgram({
          connectionId,
          provider: 'box',
          folder: {
            folderId: '1002',
            ancestorIds: ['0', '1001'],
            path: 'All Files / Acme Data Room / 01 Legal',
          },
          targetEntityId: deal.id,
          boundBy: FIXTURE_ACTOR.id,
          options: {
            mapSubfolders: false,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        }),
      )
    ).id

    expect(String(succeeded(await box.poll()))).toMatch(/cursor started/)
    const started = await cursorOf(connectionId)
    expect(started).toMatch(/^\d{19}$/)

    box.api.add({
      kind: 'file',
      id: '2300',
      name: 'Side letter.pdf',
      parentId: '1002',
      content: '%PDF-1.7 side letter',
    })
    await age()
    expect(String(succeeded(await box.poll()))).toMatch(/: 1 new, /)
    const filed = await db
      .select({ bindingId: document.bindingId })
      .from(document)
      .where(eq(document.externalId, '2300'))
    expect(filed).toEqual([{ bindingId: binding }])
    expect(
      box.api.requests.some((r) => r.url.startsWith(`${BOX_DOWNLOAD}/d/`)),
    ).toBe(true)

    // Box forgets the position: the poll's re-list path, unchanged.
    const before = await cursorOf(connectionId)
    box.sent.length = 0
    box.api.chaos.evictCursors()
    await age()
    expect(String(succeeded(await box.poll()))).toMatch(
      /cursor expired, 1 bindings re-synced$/,
    )
    expect(box.sent).toEqual([
      { queue: QUEUES.syncStorageBinding, data: { bindingId: binding } },
    ])
    expect(await cursorOf(connectionId)).not.toBe(before)
  })
})
