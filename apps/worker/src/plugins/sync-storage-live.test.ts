import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
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
import { intakeDocumentProgram } from '@spaces/core/writes/documents/intake'
import { FAKE_DRIVE_SEED, makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveApi, FetchLike } from '@spaces/sdk/testing'
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
import { SYNC_REFUSALS, syncStorageBinding } from '../jobs/sync-storage-binding'

/**
 * A bound folder's sync end to end on the real google-drive bundle against
 * the fake Drive API: the walk, the files filed on the bound record with
 * their provenance, and the re-run that files nothing twice.
 * - `fetch` is wrapped per case, so a case can kill the token mid-walk.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** The fourteen files under the seeded data room, by Drive id. */
const DATA_ROOM_FILES = FAKE_DRIVE_SEED.filter((i) => i.kind !== 'folder')
  .filter((i) => i.parentId !== 'sd-acme')
  .map((i) => i.id)

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

const aRecord = async (kind: 'company' | 'deal', name: string) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no record')
  return row.id
}

const aConnection = async () => {
  const userId = FIXTURE_ACTOR.id
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'google',
        product: 'drive',
        externalEmail: `${randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          {
            accessToken: 'unused',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
          },
          { userId, provider: 'google' },
        ),
        scopes: ['openid', 'email', 'drive.file', 'drive.readonly'],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return row.id
}

/** A download: a file's bytes or a native doc's export. */
const isDownload = (url: string) => {
  const parsed = new URL(url)
  return (
    parsed.searchParams.get('alt') === 'media' ||
    parsed.pathname.endsWith('/export')
  )
}

/**
 * The fake API, counting downloads; `killAfter` revokes the token as the
 * download past that many is asked for.
 */
const counted = (api: FakeDriveApi) => {
  const state = { downloads: 0, killAfter: Number.POSITIVE_INFINITY }
  const fetch: FetchLike = (url, init) => {
    if (isDownload(url)) {
      if (state.downloads >= state.killAfter) api.drive.revoke()
      else state.downloads += 1
    }
    return api.fetch(url, init)
  }
  return { state, fetch }
}

const wiredDrive = async (fetch: FetchLike, accessToken: string) => {
  const root = pluginsRootWith('sync-storage', ['google-drive'])
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'google-drive',
        version: '0.1.0',
        enabled: true,
        config: { folderId: 'dataroom' },
      })
      .returning({ id: integration.id })
  ).at(0)
  if (row === undefined) throw new Error('no integration')
  const fakes: FakeProviders = {
    standIn: (pluginId) =>
      pluginId === 'google-drive'
        ? { fetch, secret: 'fake-google-drive-key', accessToken }
        : null,
  }
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: 'google-drive', fakes }),
  )
  const host = makePluginHost({ enqueue: NoEnqueue, fakes })
  hosts.push(host)
  await Effect.runPromise(host.wire(loaded))
  return {
    integrationId: row.id,
    layer: Layer.mergeAll(
      storageSourcesLayer(host, { fakes, pluginsRoot: root }),
      NoEnqueue,
      pluginBreakerLayer(host),
    ),
  }
}

/** The fake API wired as the installed Drive, the data room bound to a deal. */
const boundRoom = async () => {
  const api = makeFakeDriveApi({ seed: FAKE_DRIVE_SEED })
  const wire = counted(api)
  const { integrationId, layer } = await wiredDrive(wire.fetch, api.accessToken)
  const connectionId = await aConnection()
  const deal = await aRecord('deal', 'Acme Series A')
  const { id: bindingId } = await Effect.runPromise(
    bindFolderProgram({
      connectionId,
      provider: 'google',
      folder: {
        folderId: 'dataroom',
        ancestorIds: ['root'],
        path: 'My Drive / Acme Data Room',
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
  return { api, wire, integrationId, connectionId, deal, bindingId, sync }
}

const failureOf = (exit: Exit.Exit<JobResult, JobFailure>): JobFailure => {
  if (Exit.isSuccess(exit)) throw new Error('the sync succeeded')
  const found = Cause.findErrorOption(exit.cause)
  if (found._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  return found.value
}

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const synced = (bindingId: string) =>
  db
    .select({
      id: document.entityId,
      externalId: document.externalId,
      externalStatus: document.externalStatus,
      sourcePath: document.sourcePath,
      connectionId: document.connectionId,
      filename: document.filename,
    })
    .from(document)
    .where(eq(document.bindingId, bindingId))

/** Every document on the record, whatever brought it. */
const onRecord = (entityId: string) =>
  db
    .select({ id: link.fromEntityId })
    .from(link)
    .innerJoin(document, eq(document.entityId, link.fromEntityId))
    .where(and(eq(link.toEntityId, entityId), eq(link.relation, 'tagged_in')))

const documentCount = async () => (await db.select().from(document)).length

const bindingRow = async (bindingId: string) =>
  (
    await db
      .select({
        status: storageBinding.status,
        error: storageBinding.error,
        lastSyncedAt: storageBinding.lastSyncedAt,
      })
      .from(storageBinding)
      .where(eq(storageBinding.id, bindingId))
  ).at(0)

describe('storage.sync on the google-drive bundle', () => {
  it('files the seeded data room on the bound deal with its provenance, and a re-run files nothing', async () => {
    const room = await boundRoom()

    expect(succeeded(await room.sync())).toBe(
      'synced 14 files, 14 new, 0 held, 0 attached by sha',
    )
    const rows = await synced(room.bindingId)
    expect(rows.map((r) => r.externalId).sort()).toEqual(
      [...DATA_ROOM_FILES].sort(),
    )
    expect(rows.every((r) => r.externalStatus === 'linked')).toBe(true)
    expect(rows.every((r) => r.connectionId === room.connectionId)).toBe(true)
    const pathOf = (id: string) =>
      rows.find((r) => r.externalId === id)?.sourcePath
    expect(pathOf('deck')).toBe('My Drive / Acme Data Room')
    expect(pathOf('spa')).toBe('My Drive / Acme Data Room / 01 Legal')
    expect(pathOf('minutes')).toBe(
      'My Drive / Acme Data Room / 02 Finance / Board',
    )
    expect(rows.find((r) => r.externalId === 'memo')?.filename).toBe(
      'Investment memo.docx',
    )
    expect((await onRecord(room.deal)).map((r) => r.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    )
    const after = await bindingRow(room.bindingId)
    expect(after).toMatchObject({ status: 'active', error: null })
    expect(after?.lastSyncedAt).toBeInstanceOf(Date)
    expect(room.wire.state.downloads).toBe(14)

    const before = await documentCount()
    expect(succeeded(await room.sync())).toBe(
      'synced 14 files, 0 new, 14 held, 0 attached by sha',
    )
    expect(await documentCount()).toBe(before)
    expect(await synced(room.bindingId)).toHaveLength(14)
    expect(await onRecord(room.deal)).toHaveLength(14)
    // Held files are never downloaded again.
    expect(room.wire.state.downloads).toBe(14)
  })

  it('a sync cut short mid-walk keeps what it filed, and the re-run files the rest once', async () => {
    const room = await boundRoom()
    room.wire.state.killAfter = 6

    const cut = failureOf(await room.sync())
    expect(cut._tag).toBe('JobPermanent')
    expect(await synced(room.bindingId)).toHaveLength(6)

    room.api.drive.restore()
    room.wire.state.killAfter = Number.POSITIVE_INFINITY
    expect(succeeded(await room.sync())).toBe(
      'synced 14 files, 8 new, 6 held, 0 attached by sha',
    )
    const rows = await synced(room.bindingId)
    expect(rows.map((r) => r.externalId).sort()).toEqual(
      [...DATA_ROOM_FILES].sort(),
    )
    expect(await onRecord(room.deal)).toHaveLength(14)
    expect(await bindingRow(room.bindingId)).toMatchObject({
      status: 'active',
      error: null,
    })
  })

  it('a dead token marks the binding with the provider message, keeps every copy and charges the plugin, not the worker', async () => {
    const room = await boundRoom()
    succeeded(await room.sync())
    const syncedAt = (await bindingRow(room.bindingId))?.lastSyncedAt

    room.api.drive.revoke()
    const refused = failureOf(await room.sync())

    // A typed failure the wrapper settles, never a defect that kills the worker.
    expect(refused._tag).toBe('JobPermanent')
    const after = await bindingRow(room.bindingId)
    expect(after?.status).toBe('error')
    expect(after?.error).toBe(refused.reason)
    expect(after?.error).toMatch(/Invalid Credentials/)
    expect(after?.lastSyncedAt).toEqual(syncedAt)
    expect(await synced(room.bindingId)).toHaveLength(14)
    expect(await onRecord(room.deal)).toHaveLength(14)
    const plugin = (
      await db
        .select({
          errorCount: integration.errorCount,
          lastError: integration.lastError,
          status: integration.status,
        })
        .from(integration)
        .where(eq(integration.id, room.integrationId))
    ).at(0)
    expect(plugin?.errorCount).toBe(1)
    expect(plugin?.lastError).toBe(`permanent: ${refused.reason}`)
    expect(plugin?.status).not.toBe('disabled')

    // A grant restored, the next sync clears the error.
    room.api.drive.restore()
    succeeded(await room.sync())
    expect(await bindingRow(room.bindingId)).toMatchObject({
      status: 'active',
      error: null,
    })
  })

  it('an empty folder files nothing and fails nothing', async () => {
    const api = makeFakeDriveApi({ seed: FAKE_DRIVE_SEED })
    api.drive.add({
      kind: 'folder',
      id: 'empty-room',
      name: 'Empty room',
      parentId: 'root',
    })
    const { layer } = await wiredDrive(api.fetch, api.accessToken)
    const connectionId = await aConnection()
    const company = await aRecord('company', 'Acme')
    const { id: bindingId } = await Effect.runPromise(
      bindFolderProgram({
        connectionId,
        provider: 'google',
        folder: {
          folderId: 'empty-room',
          ancestorIds: ['root'],
          path: 'My Drive / Empty room',
        },
        targetEntityId: company,
        boundBy: FIXTURE_ACTOR.id,
        options: {
          mapSubfolders: false,
          retain: 'full',
          direction: 'pull',
          sensitivity: 'inherit',
        },
      }),
    )
    const before = await documentCount()
    const exit = await Effect.runPromiseExit(
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
    expect(succeeded(exit)).toBe(
      'synced 0 files, 0 new, 0 held, 0 attached by sha',
    )
    expect(await documentCount()).toBe(before)
    expect(await synced(bindingId)).toEqual([])
    const after = await bindingRow(bindingId)
    expect(after).toMatchObject({ status: 'active', error: null })
    expect(after?.lastSyncedAt).toBeInstanceOf(Date)
  })

  it('a file whose bytes are already on the deal attaches to that document instead of a second one', async () => {
    const room = await boundRoom()
    const deck = FAKE_DRIVE_SEED.find((i) => i.id === 'deck')
    if (deck === undefined || deck.kind !== 'file') throw new Error('no deck')
    const uploaded = await Effect.runPromise(
      intakeDocumentProgram({
        stream: Readable.from([Buffer.from(deck.content)]),
        filename: 'Deck (uploaded).pdf',
        mime: 'application/pdf',
        declaredSize: null,
        kind: 'deck',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'record', entityId: room.deal }],
        actor: { userId: FIXTURE_ACTOR.id },
      }).pipe(Effect.provide(NoEnqueue)),
    )

    expect(succeeded(await room.sync())).toBe(
      'synced 14 files, 13 new, 0 held, 1 attached by sha',
    )
    expect(await onRecord(room.deal)).toHaveLength(14)
    const attached = (await synced(room.bindingId)).find(
      (r) => r.externalId === 'deck',
    )
    expect(attached).toMatchObject({
      id: uploaded.id,
      filename: 'Deck (uploaded).pdf',
      externalStatus: 'linked',
      sourcePath: 'My Drive / Acme Data Room',
    })

    // Now held: the re-run neither downloads nor duplicates it.
    expect(succeeded(await room.sync())).toBe(
      'synced 14 files, 0 new, 14 held, 0 attached by sha',
    )
    expect(await onRecord(room.deal)).toHaveLength(14)
  })

  it('a binding whose connection is gone is marked, not walked', async () => {
    const room = await boundRoom()
    await db
      .update(storageBinding)
      .set({ connectionId: null })
      .where(eq(storageBinding.id, room.bindingId))
    const refused = failureOf(await room.sync())
    expect(refused).toMatchObject({
      _tag: 'JobPermanent',
      reason: SYNC_REFUSALS.connectionGone,
    })
    expect(await bindingRow(room.bindingId)).toMatchObject({
      status: 'error',
      error: SYNC_REFUSALS.connectionGone,
    })
    expect(room.api.requests).toHaveLength(0)
  })
})
