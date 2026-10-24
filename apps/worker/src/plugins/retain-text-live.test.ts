import { createHash, randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  extractionCache,
  integration,
  storageBinding,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { setBindingRetainProgram } from '@spaces/core/writes/bindings/retain'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { storage } from '@spaces/core/writes/storage'
import { makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveSeedItem } from '@spaces/sdk/testing'
import { blobIsReferenced } from '#web/lib/documents/blob-refs'
import { documentBytesProgram } from '#web/lib/documents/remote-bytes'
import { searchAllProgram } from '#web/lib/search/query'
import { enqueued } from '#web/test/queue-stub'
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
import { ExtractionStore, extractDocument } from '../jobs/extract-document'
import { fetchRemoteBytes, retainBackfill } from '../jobs/restore-bytes'
import { syncStorageBinding } from '../jobs/sync-storage-binding'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Retain per binding on the real google-drive bundle against the fake Drive:
 * a `text` binding's files are extracted and their bytes dropped, the
 * viewer fetches them back through the connection, and a flip to `full`
 * backfills every one.
 */

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

beforeEach(async () => {
  enqueued.length = 0
  nonce = randomUUID()
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

const text = (id: string, parentId: string, content: string) =>
  ({
    kind: 'file',
    id,
    name: `${id}.txt`,
    parentId,
    mime: 'text/plain',
    content,
  }) satisfies FakeDriveSeedItem

/**
 * The rooms' contents, unique to one test: rows persist across the tests of
 * this file, and a sha another test's row holds would change the answer.
 */
let nonce = ''
const ALPHA = () => `Quillfeather cap table narrative, alpha ${nonce}.`
const SHARED = () => `Shared memo held by both rooms ${nonce}.`

const seed = (): ReadonlyArray<FakeDriveSeedItem> => [
  { kind: 'folder', id: 'root', name: 'My Drive', parentId: null },
  { kind: 'folder', id: 'textroom', name: 'Text Room', parentId: 'root' },
  { kind: 'folder', id: 'fullroom', name: 'Full Room', parentId: 'root' },
  text('t-alpha', 'textroom', ALPHA()),
  text('t-beta', 'textroom', `Quillfeather board minutes, beta ${nonce}.`),
  text('t-shared', 'textroom', SHARED()),
  text('f-shared', 'fullroom', SHARED()),
]

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const aRecord = async (name: string) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: name })
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

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const context = (queue: string) =>
  JobContext.of({
    queue,
    jobId: `test-${randomUUID()}`,
    attempt: 1,
    isFinalAttempt: true,
  })

const wiredDrive = async () => {
  const api = makeFakeDriveApi({ seed: seed() })
  const root = pluginsRootWith('retain-text', ['google-drive'])
  await db.insert(integration).values({
    capabilityId: 'google-drive',
    version: '0.1.0',
    enabled: true,
    config: { folderId: 'textroom' },
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
  const NoEnqueue = Layer.succeed(
    Enqueue,
    Enqueue.of({ enqueue: () => Effect.succeed(null) }),
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
  const sync = (bindingId: string) =>
    Effect.runPromiseExit(
      syncStorageBinding
        .run({ bindingId })
        .pipe(
          Effect.provide(layer),
          Effect.provideService(JobContext, context(QUEUES.syncStorageBinding)),
        ),
    )
  const fetchBytes = (documentId: string) =>
    Effect.runPromiseExit(
      fetchRemoteBytes
        .run({ documentId })
        .pipe(
          Effect.provide(layer),
          Effect.provideService(JobContext, context(QUEUES.fetchRemoteBytes)),
        ),
    )
  const backfill = (documentId: string) =>
    Effect.runPromiseExit(
      retainBackfill
        .run({ documentId })
        .pipe(
          Effect.provide(layer),
          Effect.provideService(JobContext, context(QUEUES.retainBackfill)),
        ),
    )
  return { api, sent, sync, fetchBytes, backfill }
}

const bind = async (input: {
  connectionId: string
  folderId: string
  path: string
  target: string
  retain: 'full' | 'text'
}) =>
  (
    await Effect.runPromise(
      bindFolderProgram({
        connectionId: input.connectionId,
        provider: 'google',
        folder: {
          folderId: input.folderId,
          ancestorIds: ['root'],
          path: input.path,
        },
        targetEntityId: input.target,
        boundBy: FIXTURE_ACTOR.id,
        options: {
          mapSubfolders: false,
          retain: input.retain,
          direction: 'pull',
          sensitivity: 'inherit',
        },
      }),
    )
  ).id

const extract = (documentId: string) =>
  Effect.runPromise(
    extractDocument
      .run({ documentId })
      .pipe(
        Effect.provide(ExtractionStore.layer),
        Effect.provideService(JobContext, context(QUEUES.extractDocument)),
      ),
  )

const rowsOf = (bindingId: string) =>
  db
    .select({
      id: document.entityId,
      externalId: document.externalId,
      blobSha: document.blobSha,
      bytesState: document.bytesState,
      status: document.extractionStatus,
      text: document.extractedText,
      hasTsv: isNotNull(document.tsv),
    })
    .from(document)
    .where(eq(document.bindingId, bindingId))

const byExternal = async (bindingId: string, externalId: string) => {
  const row = (await rowsOf(bindingId)).find((r) => r.externalId === externalId)
  if (row === undefined) throw new Error(`no ${externalId}`)
  return row
}

/** A text room synced and extracted; the full room too when asked. */
const textRoomSynced = async (withFullRoom: boolean) => {
  const drive = await wiredDrive()
  const connectionId = await aConnection()
  let fullBinding: string | null = null
  if (withFullRoom) {
    fullBinding = await bind({
      connectionId,
      folderId: 'fullroom',
      path: 'My Drive / Full Room',
      target: await aRecord(`Full ${randomUUID()}`),
      retain: 'full',
    })
    succeeded(await drive.sync(fullBinding))
    for (const r of await rowsOf(fullBinding)) await extract(r.id)
  }
  const textBinding = await bind({
    connectionId,
    folderId: 'textroom',
    path: 'My Drive / Text Room',
    target: await aRecord(`Text ${randomUUID()}`),
    retain: 'text',
  })
  succeeded(await drive.sync(textBinding))
  for (const r of await rowsOf(textBinding)) await extract(r.id)
  // Extraction's follow-on lanes; the cases below count their own sends.
  enqueued.length = 0
  return { drive, connectionId, textBinding, fullBinding }
}

describe('retain: text', () => {
  it('drops the bytes after extraction, keeps sha, text and tsv, and Cmd-K finds the file', async () => {
    const { textBinding } = await textRoomSynced(false)
    const rows = await rowsOf(textBinding)
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.status).toBe('done')
      expect(row.bytesState).toBe('remote')
      expect(row.blobSha).not.toBeNull()
      expect(row.text).not.toBeNull()
      expect(row.hasTsv).toBe(true)
      expect(await storage().exists(String(row.blobSha))).toBe(false)
    }
    const alpha = await byExternal(textBinding, 't-alpha')
    const hits = await Effect.runPromise(
      searchAllProgram({
        userId: FIXTURE_ACTOR.id,
        q: 'Quillfeather narrative',
      }),
    )
    expect(hits.map((h) => h.id)).toContain(alpha.id)
  })

  it('never discards a sha a full binding’s document holds', async () => {
    const { textBinding, fullBinding } = await textRoomSynced(true)
    if (fullBinding === null) throw new Error('no full binding')
    const held = await byExternal(fullBinding, 'f-shared')
    const shared = await byExternal(textBinding, 't-shared')
    expect(shared.blobSha).toBe(sha256(SHARED()))
    expect(held.blobSha).toBe(shared.blobSha)
    expect(held.bytesState).toBe('stored')
    expect(shared.bytesState).toBe('stored')
    expect(await storage().exists(sha256(SHARED()))).toBe(true)
    // Its siblings had no one else: theirs went.
    expect((await byExternal(textBinding, 't-alpha')).bytesState).toBe('remote')
  })

  it('a remote document is not a holder: the GC takes a stored sibling’s bytes, keeps the derived rows, and never deletes for the remote row itself', async () => {
    const { textBinding } = await textRoomSynced(false)
    const alpha = await byExternal(textBinding, 't-alpha')
    const sha = String(alpha.blobSha)
    expect(await blobIsReferenced(sha)).toBe(false)

    // A stored row on the same sha (an upload of the same file).
    const { deleteDocumentWithBlobGc } = await import('#web/lib/server/shared')
    await storage().put(sha, Buffer.from(ALPHA()), {})
    const docEntity = (
      await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: 'alpha copy' })
        .returning({ id: entity.id })
    ).at(0)
    if (docEntity === undefined) throw new Error('no entity')
    await db.insert(document).values({
      entityId: docEntity.id,
      blobSha: sha,
      filename: 'alpha copy.txt',
      kind: 'other',
      sourceClass: 'manual',
    })
    await db
      .insert(extractionCache)
      .values({ blobSha: sha, schemaKey: 'k', modelId: 'm', patch: {} })
    expect(await blobIsReferenced(sha)).toBe(true)

    // The stored row goes: the bytes go with it, the remote row's answers stay.
    await deleteDocumentWithBlobGc(docEntity.id)
    expect(await storage().exists(sha)).toBe(false)
    const cached = () =>
      db
        .select({ sha: extractionCache.blobSha })
        .from(extractionCache)
        .where(eq(extractionCache.blobSha, sha))
    expect(await cached()).toHaveLength(1)

    // The remote row goes: no store delete is attempted, its answers go.
    const deletes = vi.spyOn(storage(), 'delete')
    await deleteDocumentWithBlobGc(alpha.id)
    expect(deletes).not.toHaveBeenCalled()
    deletes.mockRestore()
    expect(await cached()).toEqual([])
  })
})

describe('the viewer on a remote document', () => {
  it('fetches through the connection, then hands a URL to the same bytes', async () => {
    const { drive, textBinding } = await textRoomSynced(false)
    const alpha = await byExternal(textBinding, 't-alpha')
    const sha = String(alpha.blobSha)

    const asked = await Effect.runPromise(
      documentBytesProgram(FIXTURE_ACTOR.id, alpha.id, { poll: false }),
    )
    expect(asked).toEqual({ state: 'fetching', from: 'Google Drive' })
    expect(enqueued).toEqual([
      {
        name: QUEUES.fetchRemoteBytes,
        data: { documentId: alpha.id },
        options: { singletonKey: alpha.id },
      },
    ])

    expect(String(succeeded(await drive.fetchBytes(alpha.id)))).toMatch(
      /^fetched /,
    )
    const ready = await Effect.runPromise(
      documentBytesProgram(FIXTURE_ACTOR.id, alpha.id, { poll: true }),
    )
    expect(ready.state).toBe('ready')
    const bytes = Buffer.from(await storage().getBytes(sha)).toString('utf8')
    expect(bytes).toBe(ALPHA())
    // A cache, not a retain: the row stays remote and the sweep may take it.
    expect((await byExternal(textBinding, 't-alpha')).bytesState).toBe('remote')
  })

  it('with the connection in error, says why instead of fetching', async () => {
    const { connectionId, textBinding } = await textRoomSynced(false)
    const alpha = await byExternal(textBinding, 't-alpha')
    await db
      .update(accountConnection)
      .set({ status: 'error', errorReason: 'invalid_grant: token revoked' })
      .where(eq(accountConnection.id, connectionId))
    const answer = await Effect.runPromise(
      documentBytesProgram(FIXTURE_ACTOR.id, alpha.id, { poll: false }),
    )
    expect(answer).toEqual({
      state: 'unavailable',
      reason: 'Google Drive cannot be reached: invalid_grant: token revoked',
    })
    expect(enqueued).toEqual([])
  })
})

describe('flipping to full', () => {
  it('sends one backfill per remote document; afterwards every sha is on disk and stored', async () => {
    const { drive, textBinding } = await textRoomSynced(false)
    const remote = (await rowsOf(textBinding)).filter(
      (r) => r.bytesState === 'remote',
    )
    expect(remote).toHaveLength(3)

    const sent: Array<{ queue: string; documentId: unknown; key?: string }> = []
    const recording = Layer.succeed(
      Enqueue,
      Enqueue.of({
        enqueue: (queue, data, options) =>
          Effect.sync(() => {
            sent.push(
              options?.singletonKey === undefined
                ? { queue, documentId: data.documentId }
                : {
                    queue,
                    documentId: data.documentId,
                    key: options.singletonKey,
                  },
            )
            return 'job'
          }),
      }),
    )
    const flipped = await Effect.runPromise(
      setBindingRetainProgram({ bindingId: textBinding, retain: 'full' }).pipe(
        Effect.provide(recording),
      ),
    )
    expect(flipped).toEqual({ retain: 'full', backfill: 3 })
    expect(sent.map((s) => s.queue)).toEqual(
      remote.map(() => QUEUES.retainBackfill),
    )
    expect(sent.map((s) => s.key).sort()).toEqual(
      remote.map((r) => r.id).sort(),
    )

    for (const s of sent) succeeded(await drive.backfill(String(s.documentId)))
    for (const row of await rowsOf(textBinding)) {
      expect(row.bytesState).toBe('stored')
      expect(await storage().exists(String(row.blobSha))).toBe(true)
    }
    const binding = (
      await db
        .select({ retain: storageBinding.retain })
        .from(storageBinding)
        .where(eq(storageBinding.id, textBinding))
    ).at(0)
    expect(binding?.retain).toBe('full')
  })
})
