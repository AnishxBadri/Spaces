import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  integration,
  link,
  storageBinding,
  storageTombstone,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import {
  bindFolderProgram,
  unlinkBindingProgram,
} from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { storage } from '@spaces/core/writes/storage'
import { FAKE_DRIVE_SEED, makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveApi, FakeDriveSeedItem } from '@spaces/sdk/testing'
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
import { pollStorageChanges } from '../jobs/poll-storage-changes'
import { syncStorageBinding } from '../jobs/sync-storage-binding'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * The resurrection guard (§8, "deleted in app" and "cursor expired") end to
 * end on the real google-drive bundle against the mutable fake Drive.
 * - Deleting a synced document in the app tombstones (binding, external id);
 *   the provider is untouched and neither the poll nor a re-list files it again.
 * - Drive's 410 re-lists the bound subtree: idempotent on external id, and it
 *   honours tombstones and `gone` rows.
 * - Unlinking and re-binding the folder clears the tombstones: the way back.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

type Sent = {
  readonly queue: string
  readonly data: Record<string, unknown>
}

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

beforeEach(async () => {
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
  // A case's copies stay, unfiled: the same seed bytes on the same record
  // would otherwise attach to the last case's document.
  await db.delete(link).where(eq(link.relation, 'tagged_in'))
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

const context = (queue: string) =>
  JobContext.of({
    queue,
    jobId: `test-${randomUUID()}`,
    attempt: 1,
    isFinalAttempt: true,
  })

/** The fake API wired as the installed Drive, with a recording `Enqueue`. */
const wiredDrive = async (
  seed: ReadonlyArray<FakeDriveSeedItem> = FAKE_DRIVE_SEED,
): Promise<{
  api: FakeDriveApi
  sent: Array<Sent>
  poll: () => Promise<Exit.Exit<JobResult, JobFailure>>
  sync: (bindingId: string) => Promise<Exit.Exit<JobResult, JobFailure>>
}> => {
  const api = makeFakeDriveApi({ seed })
  const root = pluginsRootWith('poll-storage-tombstone', ['google-drive'])
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
            fetch: api.fetch,
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
  const poll = () =>
    Effect.runPromiseExit(
      pollStorageChanges
        .run({})
        .pipe(
          Effect.provide(layer),
          Effect.provideService(JobContext, context(QUEUES.pollStorageChanges)),
        ),
    )
  const sync = (bindingId: string) =>
    Effect.runPromiseExit(
      syncStorageBinding
        .run({ bindingId })
        .pipe(
          Effect.provide(layer),
          Effect.provideService(JobContext, context(QUEUES.syncStorageBinding)),
        ),
    )
  return { api, sent, poll, sync }
}

const ROOM = {
  folderId: 'dataroom',
  ancestorIds: ['root'],
  path: 'My Drive / Acme Data Room',
}

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

/** Every binding past the poll's minimum interval. */
const age = () =>
  db
    .update(storageBinding)
    .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(storageBinding.id))

const byExternalId = async (externalId: string, connectionId: string) =>
  db
    .select({
      id: document.entityId,
      bindingId: document.bindingId,
      sourcePath: document.sourcePath,
      filename: document.filename,
      externalStatus: document.externalStatus,
      blobSha: document.blobSha,
      externalRevisionId: document.externalRevisionId,
    })
    .from(document)
    .where(
      and(
        eq(document.externalId, externalId),
        eq(document.connectionId, connectionId),
      ),
    )

const heldOne = async (externalId: string, connectionId: string) => {
  const held = (await byExternalId(externalId, connectionId)).at(0)
  if (held === undefined) throw new Error(`the walk filed no ${externalId}`)
  return held
}

const taggedIn = async (documentId: string) =>
  (
    await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(
        and(eq(link.fromEntityId, documentId), eq(link.relation, 'tagged_in')),
      )
  ).map((r) => r.to)

const documentCount = async () => (await db.select().from(document)).length

/** A request that would change the provider: anything but a read. */
const writesTo = (api: FakeDriveApi) =>
  api.requests.filter((r) => r.method !== 'GET')

/** The data room bound to a deal on this connection. */
const bindRoom = async (connectionId: string, deal: string) =>
  (
    await Effect.runPromise(
      bindFolderProgram({
        connectionId,
        provider: 'google',
        folder: { ...ROOM, ancestorIds: [...ROOM.ancestorIds] },
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
  ).id

/** The data room bound to a deal, its cursor started and its walk done. */
const syncedRoom = async () => {
  const drive = await wiredDrive()
  const connectionId = await aConnection()
  const deal = await aRecord('deal', 'Acme')
  const bindingId = await bindRoom(connectionId, deal)
  succeeded(await drive.poll())
  succeeded(await drive.sync(bindingId))
  return { drive, connectionId, deal, bindingId }
}

const tombstones = () =>
  db
    .select({
      bindingId: storageTombstone.bindingId,
      externalId: storageTombstone.externalId,
    })
    .from(storageTombstone)

/** The app's delete: the one the Files tab's server fn calls. */
const deleteInApp = async (documentId: string) => {
  const { deleteDocumentWithBlobGc } = await import('#web/lib/server/shared')
  await deleteDocumentWithBlobGc(documentId)
}

/** Every external id held on the connection, with how many rows hold it. */
const heldIds = async (connectionId: string) => {
  const rows = await db
    .select({ externalId: document.externalId })
    .from(document)
    .where(eq(document.connectionId, connectionId))
  const counts = new Map<string, number>()
  for (const { externalId } of rows)
    if (externalId !== null)
      counts.set(externalId, (counts.get(externalId) ?? 0) + 1)
  return counts
}

const syncsSent = (sent: ReadonlyArray<Sent>) =>
  sent.filter((s) => s.queue === QUEUES.syncStorageBinding)

describe('storage.poll: the resurrection guard (§8)', () => {
  it('§8 deleted in app: delete ours, never touches Drive, and the next poll does not resurrect it', async () => {
    const { drive, connectionId, bindingId } = await syncedRoom()
    const deck = await heldOne('deck', connectionId)
    const count = await documentCount()
    const writes = writesTo(drive.api).length

    await deleteInApp(deck.id)
    expect(await byExternalId('deck', connectionId)).toEqual([])
    expect(await documentCount()).toBe(count - 1)
    expect(await tombstones()).toEqual([{ bindingId, externalId: 'deck' }])
    if (deck.blobSha === null) throw new Error('the deck has no blob')
    expect(await storage().exists(deck.blobSha)).toBe(false)
    // Theirs: still there, and nothing was sent to change it.
    expect(drive.api.drive.entry('deck')).toBeDefined()
    expect(writesTo(drive.api)).toHaveLength(writes)

    // The delete-then-reimport loop: Drive reports the file again, edited.
    drive.api.drive.edit('deck', '%PDF-1.7 the deck, edited after our delete')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 1 ignored, 0 outside, 0 revised$/,
    )
    expect(await byExternalId('deck', connectionId)).toEqual([])

    // A re-sync walk lists it and leaves it out too.
    expect(String(succeeded(await drive.sync(bindingId)))).toMatch(
      /, 0 new, .*, 1 deleted here, left out$/,
    )
    expect(await byExternalId('deck', connectionId)).toEqual([])
    expect(await documentCount()).toBe(count - 1)
    expect(writesTo(drive.api)).toHaveLength(writes)
  })

  it('a document no binding brought writes no tombstone', async () => {
    const row = (
      await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: 'Pasted.pdf' })
        .returning({ id: entity.id })
    ).at(0)
    if (row === undefined) throw new Error('no entity')
    await db.insert(document).values({
      entityId: row.id,
      filename: 'Pasted.pdf',
      mime: 'application/pdf',
      externalId: 'pasted',
    })
    await deleteInApp(row.id)
    expect(await tombstones()).toEqual([])
  })

  it('§8 cursor expired (Drive 410): full re-list of the bound subtree, idempotent on external_id', async () => {
    const { drive, connectionId, bindingId } = await syncedRoom()
    const before = await heldIds(connectionId)
    const count = await documentCount()
    expect([...before.values()].every((n) => n === 1)).toBe(true)

    drive.api.drive.evictCursors()
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /cursor expired, 1 bindings re-synced$/,
    )
    expect(syncsSent(drive.sent).map((s) => s.data)).toEqual([{ bindingId }])

    // The re-list the poll sent: every file held, nothing born twice.
    expect(String(succeeded(await drive.sync(bindingId)))).toMatch(
      new RegExp(
        `^synced ${String(before.size)} files, 0 new, ${String(before.size)} held, 0 attached by sha$`,
      ),
    )
    expect(await heldIds(connectionId)).toEqual(before)
    expect(await documentCount()).toBe(count)

    // Twice is still once.
    succeeded(await drive.sync(bindingId))
    expect(await heldIds(connectionId)).toEqual(before)
    expect(await documentCount()).toBe(count)
  })

  it('a full replay resurrects nothing: the re-list honours tombstones and leaves gone rows gone', async () => {
    const { drive, connectionId, deal, bindingId } = await syncedRoom()
    const deck = await heldOne('deck', connectionId)
    const spa = await heldOne('spa', connectionId)

    // Deleted here; and gone there, by a move out of the room.
    await deleteInApp(deck.id)
    drive.api.drive.move('spa', 'root')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/, 1 gone$/)
    const gone = { ...spa, externalStatus: 'gone' as const }
    expect(await byExternalId('spa', connectionId)).toEqual([gone])

    // Both are back in the room when the cursor expires, so the re-list
    // walks over each of them.
    drive.api.drive.move('spa', 'legal')
    drive.api.drive.edit('deck', '%PDF-1.7 the deck, edited after our delete')
    const before = await heldIds(connectionId)
    const count = await documentCount()
    drive.api.drive.evictCursors()
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /cursor expired, 1 bindings re-synced$/,
    )
    expect(String(succeeded(await drive.sync(bindingId)))).toMatch(
      /, 0 new, .*, 1 gone, left untracked, 1 deleted here, left out$/,
    )

    expect(await byExternalId('deck', connectionId)).toEqual([])
    expect(await byExternalId('spa', connectionId)).toEqual([gone])
    expect(await taggedIn(spa.id)).toEqual([deal])
    expect(await heldIds(connectionId)).toEqual(before)
    expect(await documentCount()).toBe(count)
    expect(await tombstones()).toEqual([{ bindingId, externalId: 'deck' }])

    // The fresh cursor reads on, and still files nothing for either.
    drive.api.drive.nudge('deck')
    drive.api.drive.nudge('spa')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 2 ignored, 0 outside, 0 revised$/,
    )
    expect(await documentCount()).toBe(count)
  })

  it('re-binding the folder clears its tombstones, and the next poll re-imports the deleted file as new', async () => {
    const { drive, connectionId, deal, bindingId } = await syncedRoom()
    const deck = await heldOne('deck', connectionId)
    await deleteInApp(deck.id)
    expect(await tombstones()).toEqual([{ bindingId, externalId: 'deck' }])

    expect(await Effect.runPromise(unlinkBindingProgram(bindingId))).toBe(true)
    expect(await tombstones()).toEqual([])

    const rebound = await bindRoom(connectionId, deal)
    expect(rebound).not.toBe(bindingId)
    const count = await documentCount()
    drive.api.drive.nudge('deck')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 1 new, 0 held, 0 attached by sha, 0 ignored, 0 outside, 0 revised$/,
    )
    const back = await heldOne('deck', connectionId)
    expect(back.id).not.toBe(deck.id)
    expect(back.bindingId).toBe(rebound)
    expect(back.externalStatus).toBe('linked')
    expect(await taggedIn(back.id)).toEqual([deal])
    expect(await documentCount()).toBe(count + 1)

    // The re-bind's walk claims the rest and files nothing twice.
    expect(String(succeeded(await drive.sync(rebound)))).toMatch(/, 0 new, /)
    expect(await documentCount()).toBe(count + 1)
    expect(
      [...(await heldIds(connectionId)).values()].every((n) => n === 1),
    ).toBe(true)
  })
})
