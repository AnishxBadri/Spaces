import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  integration,
  entity,
  storageBinding,
  user,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { followFileProgram } from '@spaces/core/writes/bindings/follow'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { forgetConnection } from '@spaces/core/writes/connections/list'
import { FAKE_DRIVE_SEED, makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveApi, FetchLike } from '@spaces/sdk/testing'
import { pluginBreakerLayer } from './breaker'
import type { PluginBreaker } from '../jobs/plugin-breaker'
import type { StorageSources } from '../jobs/storage-sources'
import { pluginsRootWith } from './fakes/enrichers'
import type { FakeProviders } from './fakes/switch'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { storageSourcesLayer } from './storage-source'
import { JobContext } from '../run-job'
import type { JobFailure, JobResult } from '../run-job'
import { pollStorageChanges } from '../jobs/poll-storage-changes'
import { rebindStorageFolder } from '../jobs/rebind-storage-folder'
import { syncStorageBinding } from '../jobs/sync-storage-binding'

/**
 * Binding health end to end on the real google-drive bundle against the fake
 * Drive API: a revoked token turns the binding `error` at the next poll and
 * touches no document; Re-bind checks the folder on the new connection and
 * refuses in the provider's words; a re-bind's sync files nothing twice; and
 * Disconnect pauses what was bound through it.
 * - The fake serves one Drive to every connection, so "not shared with this
 *   account" is a folder hidden from the wire while one check runs.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

type Sent = { readonly queue: string; readonly data: Record<string, unknown> }

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

/** A member and their Drive connection. */
const aMember = async (
  name: string,
  scopes: ReadonlyArray<string> = [
    'openid',
    'email',
    'drive.file',
    'drive.readonly',
  ],
) => {
  const userId = `${name.toLowerCase()}-${randomUUID()}`
  const email = `${userId}@fund.example`
  await db.insert(user).values({ id: userId, name, email })
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'google',
        product: 'drive',
        externalEmail: email,
        tokensEnc: encryptBundle(
          {
            accessToken: 'unused',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
          },
          { userId, provider: 'google' },
        ),
        scopes: [...scopes],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return { userId, email, connectionId: row.id }
}

/**
 * The fake API with a hidden set: a `files.get` of a hidden id answers 404
 * `notFound`, as Drive does for a folder the account was never shared.
 */
const hiding = (api: FakeDriveApi) => {
  const hidden = new Set<string>()
  const fetch: FetchLike = (url, init) => {
    const { pathname } = new URL(url)
    const id = pathname.split('/').at(-1) ?? ''
    if (pathname.includes('/files/') && hidden.has(id))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: `File not found: ${id}.`,
              errors: [{ reason: 'notFound', message: 'File not found' }],
            },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      )
    return api.fetch(url, init)
  }
  return { hidden, fetch }
}

const wiredDrive = async () => {
  const api = makeFakeDriveApi({ seed: FAKE_DRIVE_SEED })
  const wire = hiding(api)
  const root = pluginsRootWith('binding-health', ['google-drive'])
  await db.insert(integration).values({
    capabilityId: 'google-drive',
    version: '0.1.0',
    enabled: true,
    config: { folderId: 'dataroom' },
  })
  const fakes: FakeProviders = {
    standIn: (pluginId) =>
      pluginId === 'google-drive'
        ? {
            fetch: wire.fetch,
            secret: 'fake-google-drive-key',
            accessToken: api.accessToken,
          }
        : null,
  }
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: 'google-drive', fakes }),
  )
  const host = makePluginHost({ enqueue: NoEnqueue, fakes })
  hosts.push(host)
  await Effect.runPromise(host.wire(loaded))
  const sent: Array<Sent> = []
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
  const context = (queue: string) =>
    JobContext.of({
      queue,
      jobId: `test-${randomUUID()}`,
      attempt: 1,
      isFinalAttempt: true,
    })
  const exec = (
    queue: string,
    effect: Effect.Effect<
      JobResult,
      JobFailure,
      JobContext | StorageSources | Enqueue | PluginBreaker
    >,
  ) =>
    Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(layer),
        Effect.provideService(JobContext, context(queue)),
      ),
    )
  return {
    api,
    wire,
    sent,
    poll: () => exec(QUEUES.pollStorageChanges, pollStorageChanges.run({})),
    sync: (bindingId: string) =>
      exec(QUEUES.syncStorageBinding, syncStorageBinding.run({ bindingId })),
    rebind: (data: {
      bindingId: string
      connectionId: string
      actorUserId: string
      commit: boolean
    }) => exec(QUEUES.rebindStorageFolder, rebindStorageFolder.run(data)),
  }
}

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): string => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return String(exit.value)
}

/** The permanent reason a refused job gave. */
const refusal = (exit: Exit.Exit<JobResult, JobFailure>): string => {
  if (Exit.isSuccess(exit)) throw new Error(`succeeded: ${String(exit.value)}`)
  const error = Cause.findErrorOption(exit.cause)
  if (error._tag === 'None' || error.value._tag !== 'JobPermanent')
    throw new Error(Cause.pretty(exit.cause))
  return error.value.reason
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

const bindLegal = async (connectionId: string, boundBy: string) =>
  (
    await Effect.runPromise(
      bindFolderProgram({
        connectionId,
        provider: 'google',
        folder: {
          folderId: 'legal',
          ancestorIds: ['root', 'dataroom'],
          path: 'My Drive / Acme Data Room / 01 Legal',
        },
        targetEntityId: await aDeal('Vayu'),
        boundBy,
        options: {
          mapSubfolders: false,
          retain: 'full',
          direction: 'pull',
          sensitivity: 'inherit',
        },
      }),
    )
  ).id

/**
 * The seeded cap table, pasted through the member's connection and followed
 * on a record of its own: a file-grain binding on the same connection.
 */
const aFollowed = async (member: {
  readonly userId: string
  readonly connectionId: string
}) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: 'PK cap table' })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no document')
  await db.insert(document).values({
    entityId: row.id,
    blobSha: randomUUID().replaceAll('-', ''),
    filename: 'PK cap table.xlsx',
    sourcePath: 'My Drive / Acme Data Room',
    connectionId: member.connectionId,
    externalId: 'captable',
    externalStatus: 'linked',
    externalRevisionId: 'pasted',
  })
  const followed = await Effect.runPromise(
    followFileProgram({
      documentId: row.id,
      targetEntityId: await aDeal('PK'),
      userId: member.userId,
    }),
  )
  return followed.bindingId
}

/** Every document a binding brought, as the dedupe key and its state. */
const documentsOf = (bindingId: string) =>
  db
    .select({
      id: document.entityId,
      connectionId: document.connectionId,
      externalId: document.externalId,
      externalStatus: document.externalStatus,
      blobSha: document.blobSha,
    })
    .from(document)
    .where(eq(document.bindingId, bindingId))
    .orderBy(document.externalId)

const bindingOf = async (id: string) =>
  (
    await db
      .select({
        connectionId: storageBinding.connectionId,
        status: storageBinding.status,
        error: storageBinding.error,
      })
      .from(storageBinding)
      .where(eq(storageBinding.id, id))
  ).at(0)

const age = () =>
  db
    .update(storageBinding)
    .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(storageBinding.id))

describe('binding health on the google-drive bundle', () => {
  it('a revoked grant turns the binding error at the next poll with the provider’s words, and touches no document', async () => {
    const drive = await wiredDrive()
    const priya = await aMember('Priya')
    const id = await bindLegal(priya.connectionId, priya.userId)
    succeeded(await drive.sync(id))
    const followed = await aFollowed(priya)
    succeeded(await drive.poll())
    const before = await documentsOf(id)
    expect(before.length).toBeGreaterThan(0)
    const followedBefore = await documentsOf(followed)
    expect(followedBefore).toHaveLength(1)

    drive.api.drive.revoke()
    await age()
    succeeded(await drive.poll())
    // The folder and the followed file alike: the token is the connection's.
    for (const bindingId of [id, followed])
      expect(await bindingOf(bindingId)).toEqual({
        connectionId: priya.connectionId,
        status: 'error',
        error: expect.stringMatching(/^Google said: .*Invalid Credentials/),
      })
    expect(await documentsOf(id)).toEqual(before)
    expect(await documentsOf(followed)).toEqual(followedBefore)
  })

  it('Re-bind refuses by name when the folder is not shared with the new account, and changes nothing', async () => {
    const drive = await wiredDrive()
    const priya = await aMember('Priya')
    const tomas = await aMember('Tomas')
    const id = await bindLegal(priya.connectionId, priya.userId)
    succeeded(await drive.sync(id))
    await db
      .update(storageBinding)
      .set({ status: 'error', error: 'Google said: Invalid Credentials' })
      .where(eq(storageBinding.id, id))

    const sentBefore = drive.sent.length
    drive.wire.hidden.add('legal')
    for (const commit of [false, true])
      expect(
        refusal(
          await drive.rebind({
            bindingId: id,
            connectionId: tomas.connectionId,
            actorUserId: tomas.userId,
            commit,
          }),
        ),
      ).toBe(
        `Google said: notFound · the folder isn’t shared with ${tomas.email} · nothing changed`,
      )
    expect(await bindingOf(id)).toEqual({
      connectionId: priya.connectionId,
      status: 'error',
      error: 'Google said: Invalid Credentials',
    })
    expect(drive.sent.slice(sentBefore)).toEqual([])
  })

  it('Re-bind refuses a connection missing the folder scope before asking the provider', async () => {
    const drive = await wiredDrive()
    const priya = await aMember('Priya')
    const narrow = await aMember('Tomas', ['openid', 'email', 'drive.file'])
    const id = await bindLegal(priya.connectionId, priya.userId)
    await db
      .update(storageBinding)
      .set({ status: 'error', error: 'gone' })
      .where(eq(storageBinding.id, id))
    const asked = drive.api.requests.length
    expect(
      refusal(
        await drive.rebind({
          bindingId: id,
          connectionId: narrow.connectionId,
          actorUserId: narrow.userId,
          commit: false,
        }),
      ),
    ).toBe(`${narrow.email} has not granted drive.readonly · nothing changed`)
    expect(drive.api.requests.length).toBe(asked)
  })

  it('Re-bind refuses someone else’s connection and a binding still syncing', async () => {
    const drive = await wiredDrive()
    const priya = await aMember('Priya')
    const tomas = await aMember('Tomas')
    const id = await bindLegal(priya.connectionId, priya.userId)
    expect(
      refusal(
        await drive.rebind({
          bindingId: id,
          connectionId: tomas.connectionId,
          actorUserId: tomas.userId,
          commit: true,
        }),
      ),
    ).toMatch(/only a paused or failing one is re-bound/)
    await db
      .update(storageBinding)
      .set({ status: 'error' })
      .where(eq(storageBinding.id, id))
    expect(
      refusal(
        await drive.rebind({
          bindingId: id,
          connectionId: priya.connectionId,
          actorUserId: tomas.userId,
          commit: true,
        }),
      ),
    ).toBe('Not your connection')
  })

  it('a passed check, then the re-bind: the binding moves, the sync re-lists, and no document is filed twice', async () => {
    const startedAt = new Date()
    const drive = await wiredDrive()
    const priya = await aMember('Priya')
    const tomas = await aMember('Tomas')
    const id = await bindLegal(priya.connectionId, priya.userId)
    succeeded(await drive.sync(id))
    const before = await documentsOf(id)
    drive.api.drive.revoke()
    await age()
    succeeded(await drive.poll())
    expect((await bindingOf(id))?.status).toBe('error')
    // The provider honours Tomas, who can read the folder.
    drive.api.drive.restore()

    const files = `${String(before.length)} files`
    expect(
      succeeded(
        await drive.rebind({
          bindingId: id,
          connectionId: tomas.connectionId,
          actorUserId: tomas.userId,
          commit: false,
        }),
      ),
    ).toBe(`Can read the folder · ${files} · drive.readonly`)
    expect((await bindingOf(id))?.connectionId).toBe(priya.connectionId)

    const sentBefore = drive.sent.length
    expect(
      succeeded(
        await drive.rebind({
          bindingId: id,
          connectionId: tomas.connectionId,
          actorUserId: tomas.userId,
          commit: true,
        }),
      ),
    ).toMatch(/^re-bound My Drive \/ Acme Data Room \/ 01 Legal to /)
    expect(await bindingOf(id)).toEqual({
      connectionId: tomas.connectionId,
      status: 'active',
      error: null,
    })
    expect(drive.sent.slice(sentBefore)).toEqual([
      { queue: QUEUES.syncStorageBinding, data: { bindingId: id } },
    ])

    const resync = succeeded(await drive.sync(id))
    expect(resync).toMatch(/ 0 new, /)
    const after = await documentsOf(id)
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id))
    expect(after.every((d) => d.connectionId === tomas.connectionId)).toBe(true)
    // Nor anywhere else: the files exist once each, whoever holds them.
    const ids = before.flatMap((d) =>
      d.externalId === null ? [] : [d.externalId],
    )
    const everywhere = await db
      .select({ id: document.entityId })
      .from(document)
      .where(
        and(
          inArray(document.externalId, ids),
          gt(document.createdAt, startedAt),
        ),
      )
    expect(everywhere).toHaveLength(before.length)
  })

  it('Disconnect pauses the binding and keeps its documents; a re-bind brings it back with no duplicates', async () => {
    const drive = await wiredDrive()
    const priya = await aMember('Priya')
    const tomas = await aMember('Tomas')
    const id = await bindLegal(priya.connectionId, priya.userId)
    succeeded(await drive.sync(id))
    const before = await documentsOf(id)

    expect(await forgetConnection(priya.userId, priya.connectionId)).toBe(true)
    expect(await bindingOf(id)).toEqual({
      connectionId: null,
      status: 'paused',
      error: expect.stringMatching(/^Priya disconnected \d{4}-\d{2}-\d{2}$/),
    })
    expect((await documentsOf(id)).map((d) => d.id)).toEqual(
      before.map((d) => d.id),
    )
    expect(await drive.sync(id)).toEqual(Exit.succeed('the binding is paused'))

    succeeded(
      await drive.rebind({
        bindingId: id,
        connectionId: tomas.connectionId,
        actorUserId: tomas.userId,
        commit: true,
      }),
    )
    expect(succeeded(await drive.sync(id))).toMatch(/ 0 new, /)
    expect((await documentsOf(id)).map((d) => d.id)).toEqual(
      before.map((d) => d.id),
    )
  })
})
