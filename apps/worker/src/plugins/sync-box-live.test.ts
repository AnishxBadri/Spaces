import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  integration,
  link,
  storageBinding,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import {
  BOX_DOWNLOAD,
  FAKE_DRIVE_SEED,
  makeFakeBoxApi,
} from '@spaces/sdk/testing'
import type { FakeDriveSeedItem } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pluginBreakerLayer } from './breaker'
import { pluginsRootWith } from './fakes/enrichers'
import type { FakeProviders } from './fakes/switch'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { storageSourcesLayer } from './storage-source'
import { JobContext } from '../run-job'
import type { JobFailure, JobResult } from '../run-job'
import { syncStorageBinding } from '../jobs/sync-storage-binding'

/**
 * The second provider through core's unchanged sync: the real box bundle
 * against the fake Box, its data room bound to a deal. The walk, the
 * filing and the provenance are the ones Drive's binding runs; only the
 * plugin differs, and what lands is Drive's data room file for file.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

beforeEach(async () => {
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

/**
 * What Drive's binding of the same data room files, written from the fake
 * Drive's seed: each file's folder path under the room, and its name — the
 * native memo exported, which on Box is a Box Note read as text.
 */
const driveRoom = () => {
  const byId = new Map<string, FakeDriveSeedItem>(
    FAKE_DRIVE_SEED.map((i) => [i.id, i]),
  )
  const pathOf = (id: string | null): Array<string> | null => {
    if (id === 'dataroom') return []
    const folder = id === null ? undefined : byId.get(id)
    if (folder === undefined) return null
    const up = pathOf(folder.parentId)
    return up === null ? null : [...up, folder.name]
  }
  return FAKE_DRIVE_SEED.filter((i) => i.kind !== 'folder').flatMap((i) => {
    const folders = pathOf(i.parentId)
    if (folders === null) return []
    const name = i.kind === 'native' ? `${i.name}.txt` : i.name
    return [{ folders: folders.join(' / '), name }]
  })
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

const aDeal = async (name: string) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no record')
  return row.id
}

/** The fake Box wired as the installed Box, its data room bound to a deal. */
const boundBoxRoom = async () => {
  const api = makeFakeBoxApi()
  const root = pluginsRootWith('sync-box', ['box'])
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'box',
        version: '0.1.0',
        enabled: true,
        config: { folderId: '1001' },
      })
      .returning({ id: integration.id })
  ).at(0)
  if (row === undefined) throw new Error('no integration')
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
  const layer = Layer.mergeAll(
    storageSourcesLayer(host, { fakes, pluginsRoot: root }),
    NoEnqueue,
    pluginBreakerLayer(host),
  )
  const connectionId = await aBoxConnection()
  const deal = await aDeal('Acme Series B')
  const { id: bindingId } = await Effect.runPromise(
    bindFolderProgram({
      connectionId,
      provider: 'box',
      folder: {
        folderId: '1001',
        ancestorIds: ['0'],
        path: 'All Files / Acme Data Room',
      },
      targetEntityId: deal,
      boundBy: FIXTURE_ACTOR.id,
      options: {
        mapSubfolders: false,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
    }),
  )
  const sync = () =>
    Effect.runPromiseExit(
      syncStorageBinding.run({ bindingId }).pipe(
        Effect.provide(layer),
        Effect.provideService(
          JobContext,
          JobContext.of({
            queue: QUEUES.syncStorageBinding,
            jobId: `test-${randomUUID()}`,
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
      ),
    )
  return { api, connectionId, deal, bindingId, sync }
}

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const synced = (bindingId: string) =>
  db
    .select({
      id: document.entityId,
      bindingId: document.bindingId,
      externalId: document.externalId,
      externalStatus: document.externalStatus,
      sourcePath: document.sourcePath,
      connectionId: document.connectionId,
      filename: document.filename,
    })
    .from(document)
    .where(eq(document.bindingId, bindingId))

const onRecord = (entityId: string) =>
  db
    .select({ id: link.fromEntityId })
    .from(link)
    .innerJoin(document, eq(document.entityId, link.fromEntityId))
    .where(and(eq(link.toEntityId, entityId), eq(link.relation, 'tagged_in')))

const documentCount = async () => (await db.select().from(document)).length

const BOX_ROOM = 'All Files / Acme Data Room'

const byPlace = (a: object, b: object) =>
  JSON.stringify(a).localeCompare(JSON.stringify(b))

describe('storage.sync on the box bundle', () => {
  it('files the data room Drive’s binding files, with source_path, external_id and binding_id, and a re-run files nothing', async () => {
    const room = await boundBoxRoom()

    expect(succeeded(await room.sync())).toBe(
      'synced 14 files, 14 new, 0 held, 0 attached by sha',
    )
    const rows = await synced(room.bindingId)
    expect(rows).toHaveLength(14)
    for (const row of rows) {
      expect(row.externalId).toMatch(/^\d+$/)
      expect(row.bindingId).toBe(room.bindingId)
      expect(row.externalStatus).toBe('linked')
      expect(row.connectionId).toBe(room.connectionId)
    }
    // File for file what Drive's binding of the same room files.
    const landed = rows
      .map((r) => ({
        folders: (r.sourcePath ?? '').slice(BOX_ROOM.length + 3),
        name: r.filename,
      }))
      .sort(byPlace)
    expect(landed).toEqual(driveRoom().sort(byPlace))
    expect(rows.every((r) => r.sourcePath?.startsWith(BOX_ROOM))).toBe(true)
    expect(rows.find((r) => r.externalId === '2007')?.sourcePath).toBe(
      `${BOX_ROOM} / 02 Finance / Board`,
    )
    expect((await onRecord(room.deal)).map((r) => r.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    )
    const downloads = () =>
      room.api.requests.filter((r) => r.url.startsWith(`${BOX_DOWNLOAD}/`))
        .length
    // Thirteen downloads and the memo's text representation.
    expect(downloads()).toBe(14)

    const before = await documentCount()
    expect(succeeded(await room.sync())).toBe(
      'synced 14 files, 0 new, 14 held, 0 attached by sha',
    )
    expect(await documentCount()).toBe(before)
    expect(await synced(room.bindingId)).toHaveLength(14)
    expect(await onRecord(room.deal)).toHaveLength(14)
    expect(downloads()).toBe(14)
  })
})
