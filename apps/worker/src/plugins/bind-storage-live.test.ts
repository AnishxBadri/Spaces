import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  entity,
  integration,
  storageBinding,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { FAKE_DRIVE_SEED, makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveApi } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pluginsRootWith } from './fakes/enrichers'
import type { FakeProviders } from './fakes/switch'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { storageSourcesLayer } from './storage-source'
import type { StorageSources } from '../jobs/storage-sources'
import { JobContext } from '../run-job'
import type { JobFailure } from '../run-job'
import { BIND_REFUSALS, bindStorageFolder } from '../jobs/bind-storage-folder'
import type { BindStorageFolderData } from '../jobs/bind-storage-folder'

/**
 * Link a Drive folder end to end on the real google-drive bundle against the
 * fake Drive's seeded data room: `getFolder` supplies the ancestry the
 * nesting guard tests, a refusal is the job's permanent reason, and a bind
 * sends its first sync.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** Every job the bind sent. */
const sent: Array<{ queue: string; data: unknown; key: string | undefined }> =
  []
const Recording = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data, options) =>
      Effect.sync(() => {
        sent.push({ queue, data, key: options?.singletonKey })
        return `job-${String(sent.length)}`
      }),
  }),
)

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

beforeEach(async () => {
  sent.length = 0
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

const standInWith = (api: FakeDriveApi): FakeProviders => ({
  standIn: (pluginId) =>
    pluginId === 'google-drive'
      ? {
          fetch: api.fetch,
          secret: 'fake-google-drive-key',
          accessToken: api.accessToken,
        }
      : null,
})

const wiredDrive = async (api: FakeDriveApi) => {
  const root = pluginsRootWith('bind-storage', ['google-drive'])
  await db.insert(integration).values({
    capabilityId: 'google-drive',
    version: '0.1.0',
    enabled: true,
    config: { folderId: 'dataroom' },
  })
  const fakes = standInWith(api)
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: 'google-drive', fakes }),
  )
  const host = makePluginHost({ enqueue: NoEnqueue, fakes })
  hosts.push(host)
  await Effect.runPromise(host.wire(loaded))
  return storageSourcesLayer(host, { fakes, pluginsRoot: root })
}

const run = (data: BindStorageFolderData, layer: Layer.Layer<StorageSources>) =>
  Effect.runPromiseExit(
    bindStorageFolder.run(data).pipe(
      Effect.provide(Layer.merge(layer, Recording)),
      Effect.provideService(
        JobContext,
        JobContext.of({
          queue: QUEUES.bindStorageFolder,
          jobId: `test-${randomUUID()}`,
          attempt: 1,
          isFinalAttempt: true,
        }),
      ),
    ),
  )

const reasonOf = (exit: Exit.Exit<unknown, JobFailure>): string => {
  if (Exit.isSuccess(exit)) throw new Error('the job succeeded')
  const found = Cause.findErrorOption(exit.cause)
  if (found._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  return found.value.reason
}

const OPTIONS = {
  mapSubfolders: true,
  retain: 'full',
  direction: 'pull',
  sensitivity: 'inherit',
} as const

describe('storage.bind-folder on the google-drive bundle', () => {
  it('binds the seeded data room with its ancestry, then refuses its parent and its child by name', async () => {
    const layer = await wiredDrive(makeFakeDriveApi({ seed: FAKE_DRIVE_SEED }))
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme Series A')
    const company = await aRecord('company', 'Acme')
    const base = {
      connectionId,
      actorUserId: FIXTURE_ACTOR.id,
      options: OPTIONS,
    }

    const bound = await run(
      { ...base, folder: { id: 'dataroom' }, targetEntityId: deal },
      layer,
    )
    expect(Exit.isSuccess(bound)).toBe(true)
    const binding = (
      await db.select({ id: storageBinding.id }).from(storageBinding)
    ).at(0)
    // The first sync, keyed by the binding so two never overlap.
    expect(sent).toEqual([
      {
        queue: QUEUES.syncStorageBinding,
        data: { bindingId: binding?.id },
        key: binding?.id,
      },
    ])
    expect(
      await db
        .select({
          folderId: storageBinding.folderId,
          folderPath: storageBinding.folderPath,
          ancestorIds: storageBinding.ancestorIds,
          lastSyncedAt: storageBinding.lastSyncedAt,
        })
        .from(storageBinding),
    ).toEqual([
      {
        folderId: 'dataroom',
        folderPath: 'My Drive / Acme Data Room',
        ancestorIds: ['root'],
        lastSyncedAt: null,
      },
    ])

    expect(
      reasonOf(
        await run(
          { ...base, folder: { id: 'root' }, targetEntityId: company },
          layer,
        ),
      ),
    ).toBe(
      'My Drive holds My Drive / Acme Data Room, which is linked to Acme Series A. A folder has one owner.',
    )
    expect(
      reasonOf(
        await run(
          {
            ...base,
            folder: { url: 'https://drive.google.com/drive/folders/board' },
            targetEntityId: company,
          },
          layer,
        ),
      ),
    ).toBe(
      'My Drive / Acme Data Room / 02 Finance / Board is inside My Drive / Acme Data Room, which is linked to Acme Series A. A folder has one owner.',
    )
  })

  it('refuses a file link and a folder the account cannot read', async () => {
    const layer = await wiredDrive(makeFakeDriveApi({ seed: FAKE_DRIVE_SEED }))
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme Series A')
    const base = {
      connectionId,
      actorUserId: FIXTURE_ACTOR.id,
      options: OPTIONS,
      targetEntityId: deal,
    }
    expect(
      reasonOf(
        await run(
          {
            ...base,
            folder: { url: 'https://drive.google.com/file/d/deck/view' },
          },
          layer,
        ),
      ),
    ).toBe(BIND_REFUSALS.notAFolder)
    expect(
      reasonOf(await run({ ...base, folder: { id: 'never-seeded' } }, layer)),
    ).toBe(BIND_REFUSALS.notFound)
    // A refused bind sends no sync.
    expect(sent).toEqual([])
  })
})
