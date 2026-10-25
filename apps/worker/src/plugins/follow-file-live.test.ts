import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  documentRevision,
  entity,
  integration,
  link,
  storageBinding,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import {
  FOLLOW_REFUSALS,
  documentRevisionsProgram,
  followFileProgram,
  unfollowFileProgram,
} from '@spaces/core/writes/bindings/follow'
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
import { fetchStorageFile } from '../jobs/fetch-storage-file'
import { pollStorageChanges } from '../jobs/poll-storage-changes'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Live files end to end on the real google-drive bundle against the mutable
 * fake Drive: a file picked once onto a company, then followed from it.
 * - Following attaches a file binding to the document already filed.
 * - Each provider revision advances the document and appends the prior
 *   bytes, under their revision id, to `document_revision`.
 * - Followed files share the connection's one `changes` pass.
 * - Unfollow and a provider delete stop the binding; no revision is lost.
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
  await db.delete(link).where(eq(link.relation, 'tagged_in'))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

const aCompany = async () => {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Acme ${randomUUID()}` })
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
        scopes: ['openid', 'email', 'drive.file'],
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

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Ten models in My Drive, outside the data room. */
const MODELS: ReadonlyArray<FakeDriveSeedItem> = Array.from(
  { length: 10 },
  (_, i) => ({
    kind: 'file',
    id: `model-${String(i)}`,
    name: `Model ${String(i)}.xlsx`,
    parentId: 'root',
    mime: XLSX,
    content: `PK model ${String(i)}`,
  }),
)

/** The fake API wired as the installed Drive: pick a file, poll. */
const wiredDrive = async () => {
  const api = makeFakeDriveApi({ seed: [...FAKE_DRIVE_SEED, ...MODELS] })
  const root = pluginsRootWith('follow-file', ['google-drive'])
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
  const recording = Layer.succeed(
    Enqueue,
    Enqueue.of({ enqueue: () => Effect.succeed('job') }),
  )
  const layer = Layer.mergeAll(
    storageSourcesLayer(host, { fakes, pluginsRoot: root }),
    recording,
    pluginBreakerLayer(host),
  )
  const connectionId = await aConnection()
  const company = await aCompany()
  const poll = async () =>
    String(
      succeeded(
        await Effect.runPromiseExit(
          pollStorageChanges
            .run({})
            .pipe(
              Effect.provide(layer),
              Effect.provideService(
                JobContext,
                context(QUEUES.pollStorageChanges),
              ),
            ),
        ),
      ),
    )
  /** Attach from Drive: the pick-once path, filed on the company. */
  const pick = async (fileId: string) => {
    succeeded(
      await Effect.runPromiseExit(
        fetchStorageFile
          .run({
            url: `https://drive.google.com/file/d/${fileId}/view`,
            connectionId,
            attachTo: company,
            actorUserId: FIXTURE_ACTOR.id,
          })
          .pipe(
            Effect.provide(layer),
            Effect.provideService(JobContext, context(QUEUES.fetchStorageFile)),
          ),
      ),
    )
    return heldOne(fileId, connectionId)
  }
  const follow = (documentId: string) =>
    Effect.runPromise(
      followFileProgram({
        documentId,
        targetEntityId: company,
        userId: FIXTURE_ACTOR.id,
      }),
    )
  /** Why a follow is refused; throws when it is not. */
  const refusedWith = async (documentId: string) => {
    const error = await Effect.runPromise(
      followFileProgram({
        documentId,
        targetEntityId: company,
        userId: FIXTURE_ACTOR.id,
      }).pipe(Effect.flip),
    )
    if (error._tag !== 'BindingRefused') throw new Error(error._tag)
    return error.reason
  }
  return { api, connectionId, company, poll, pick, follow, refusedWith }
}

/** Every binding past the poll's minimum interval. */
const age = () =>
  db
    .update(storageBinding)
    .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(storageBinding.lastSyncedAt))

const heldOne = async (externalId: string, connectionId: string) => {
  const row = (
    await db
      .select({
        id: document.entityId,
        bindingId: document.bindingId,
        blobSha: document.blobSha,
        externalRevisionId: document.externalRevisionId,
        externalStatus: document.externalStatus,
      })
      .from(document)
      .where(
        and(
          eq(document.externalId, externalId),
          eq(document.connectionId, connectionId),
        ),
      )
  ).at(0)
  if (row === undefined) throw new Error(`nothing filed for ${externalId}`)
  return row
}

const revisionsOf = (documentId: string) =>
  db
    .select({
      blobSha: documentRevision.blobSha,
      externalRevisionId: documentRevision.externalRevisionId,
    })
    .from(documentRevision)
    .where(eq(documentRevision.documentId, documentId))
    .orderBy(asc(documentRevision.at), asc(documentRevision.id))

const bindingOf = async (id: string) => {
  const row = (
    await db
      .select({
        grain: storageBinding.grain,
        fileId: storageBinding.fileId,
        folderId: storageBinding.folderId,
        direction: storageBinding.direction,
        status: storageBinding.status,
        targetEntityId: storageBinding.targetEntityId,
      })
      .from(storageBinding)
      .where(eq(storageBinding.id, id))
  ).at(0)
  if (row === undefined) throw new Error('no binding')
  return row
}

const documentCount = async () => (await db.select().from(document)).length

const changesPasses = (api: FakeDriveApi) =>
  api.requests.filter((r) => r.path === '/changes').length

describe('live files: follow a file, keep its revisions', () => {
  it('following a file already filed attaches the binding to that document, never a second one', async () => {
    const drive = await wiredDrive()
    const cap = await drive.pick('captable')
    const count = await documentCount()

    const { bindingId } = await drive.follow(cap.id)
    expect(await documentCount()).toBe(count)
    expect((await heldOne('captable', drive.connectionId)).bindingId).toBe(
      bindingId,
    )
    expect(await bindingOf(bindingId)).toEqual({
      grain: 'file',
      fileId: 'captable',
      folderId: null,
      direction: 'pull',
      status: 'active',
      targetEntityId: drive.company,
    })
    // A second follow finds the first: one binding, one document.
    expect((await drive.follow(cap.id)).bindingId).toBe(bindingId)
    expect(await db.select().from(storageBinding)).toHaveLength(1)
  })

  it('three edits make three revisions with the provider’s revision ids, and one current sha', async () => {
    const drive = await wiredDrive()
    const cap = await drive.pick('captable')
    await drive.follow(cap.id)
    // The first poll starts the cursor and reads the file once: unchanged.
    expect(await drive.poll()).toContain('cursor started')
    const linked = await heldOne('captable', drive.connectionId)
    expect(linked.blobSha).toBe(cap.blobSha)
    expect(await revisionsOf(cap.id)).toEqual([])

    for (const n of [1, 2, 3]) {
      drive.api.drive.edit('captable', `PK cap table, edit ${String(n)}`)
      await age()
      expect(await drive.poll()).toContain('1 revised')
    }

    const now = await heldOne('captable', drive.connectionId)
    const revisions = await revisionsOf(cap.id)
    expect(revisions).toHaveLength(3)
    const ids = revisions.map((r) => r.externalRevisionId)
    expect(ids.every((id) => id !== null)).toBe(true)
    expect(new Set([...ids, now.externalRevisionId]).size).toBe(4)
    expect(revisions[0]).toEqual({
      blobSha: cap.blobSha,
      externalRevisionId: cap.externalRevisionId,
    })
    const shas = new Set([...revisions.map((r) => r.blobSha), now.blobSha])
    expect(shas.size).toBe(4)
    for (const sha of shas)
      if (sha !== null) expect(await storage().exists(sha)).toBe(true)

    // The ledger the viewer draws: rev 4 current, newest first.
    const ledger = await Effect.runPromise(documentRevisionsProgram(cap.id))
    expect(ledger?.map((r) => [r.rev, r.current, r.revisionId])).toEqual([
      [4, true, now.externalRevisionId],
      [3, false, ids[2]],
      [2, false, ids[1]],
      [1, false, ids[0]],
    ])
  })

  it('ten followed files on one drive add no changes.list pass to a poll', async () => {
    const drive = await wiredDrive()
    const one = await drive.pick('model-0')
    await drive.follow(one.id)
    await drive.poll()
    drive.api.drive.edit('model-0', 'PK model 0, edited')
    await age()
    const before = changesPasses(drive.api)
    expect(await drive.poll()).toContain('1 revised')
    // One `changes` pass, however many pages the API answers it in.
    const alone = changesPasses(drive.api) - before
    expect(alone).toBeGreaterThan(0)

    for (const item of MODELS.slice(1)) {
      const doc = await drive.pick(item.id)
      await drive.follow(doc.id)
    }
    await drive.poll()
    for (const item of MODELS) drive.api.drive.edit(item.id, `PK ${item.id} v3`)
    await age()
    const from = changesPasses(drive.api)
    expect(await drive.poll()).toContain('10 revised')
    expect(changesPasses(drive.api) - from).toBe(alone)
  })

  it('unfollowing stops polling and keeps every revision; following again resumes', async () => {
    const drive = await wiredDrive()
    const cap = await drive.pick('captable')
    const { bindingId } = await drive.follow(cap.id)
    await drive.poll()
    drive.api.drive.edit('captable', 'PK cap table, edit 1')
    await age()
    await drive.poll()
    const kept = await revisionsOf(cap.id)
    expect(kept).toHaveLength(1)
    const held = await heldOne('captable', drive.connectionId)

    expect(await Effect.runPromise(unfollowFileProgram(cap.id))).toBe(true)
    expect((await bindingOf(bindingId)).status).toBe('paused')
    drive.api.drive.edit('captable', 'PK cap table, edit 2')
    await age()
    const requests = drive.api.requests.length
    expect(await drive.poll()).toBe('no binding due')
    expect(drive.api.requests).toHaveLength(requests)
    expect(await revisionsOf(cap.id)).toEqual(kept)
    expect(await heldOne('captable', drive.connectionId)).toEqual(held)

    // Followed again: the same binding, and the missed edit is read.
    expect((await drive.follow(cap.id)).bindingId).toBe(bindingId)
    await age()
    expect(await drive.poll()).toContain('1 revised')
    expect(await revisionsOf(cap.id)).toHaveLength(2)
  })

  it('a followed file deleted at the provider is marked gone and stops the binding, every revision kept', async () => {
    const drive = await wiredDrive()
    const cap = await drive.pick('captable')
    const { bindingId } = await drive.follow(cap.id)
    await drive.poll()
    drive.api.drive.edit('captable', 'PK cap table, edit 1')
    await age()
    await drive.poll()
    const kept = await revisionsOf(cap.id)
    expect(kept).toHaveLength(1)

    drive.api.drive.remove('captable')
    await age()
    expect(await drive.poll()).toContain('1 gone')
    const gone = await heldOne('captable', drive.connectionId)
    expect(gone.externalStatus).toBe('gone')
    expect(gone.bindingId).toBe(bindingId)
    expect((await bindingOf(bindingId)).status).toBe('paused')
    expect(await revisionsOf(cap.id)).toEqual(kept)
    for (const sha of [gone.blobSha, ...kept.map((r) => r.blobSha)])
      if (sha !== null) expect(await storage().exists(sha)).toBe(true)
    // Nothing deleted at the provider, and nothing left to poll.
    expect(drive.api.requests.filter((r) => r.method !== 'GET')).toEqual([])
    await age()
    expect(await drive.poll()).toBe('no binding due')
    // Gone is one way: it cannot be followed again.
    expect(await drive.refusedWith(cap.id)).toBe(FOLLOW_REFUSALS.gone)
  })

  it('a file a bound folder brought is not followed: its folder already syncs it', async () => {
    const drive = await wiredDrive()
    const deal = drive.company
    await Effect.runPromise(
      bindFolderProgram({
        connectionId: drive.connectionId,
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
    const cap = await drive.pick('captable')
    const folderBinding = (await db.select().from(storageBinding)).at(0)
    await db
      .update(document)
      .set({ bindingId: folderBinding?.id ?? null })
      .where(eq(document.entityId, cap.id))
    expect(await drive.refusedWith(cap.id)).toBe(FOLLOW_REFUSALS.inFolder)
  })
})
