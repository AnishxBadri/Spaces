import { createHash, randomUUID } from 'node:crypto'
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
import type { SourceClass } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import type { BindingOptions } from '@spaces/core/writes/bindings/bind'
import {
  exportPlanOf,
  waitingExportsProgram,
} from '@spaces/core/writes/bindings/export'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { birthDocumentProgram } from '@spaces/core/writes/documents/birth'
import { storage } from '@spaces/core/writes/storage'
import { makeFakeBoxApi, makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveApi } from '@spaces/sdk/testing'
import { enqueued } from '#web/test/queue-stub'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pluginBreakerLayer } from './breaker'
import { pluginsRootWith } from './fakes/enrichers'
import type { FakeProviders } from './fakes/switch'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { storageSourcesLayer } from './storage-source'
import { JobContext, JobRetryable } from '../run-job'
import type { JobFailure, JobResult } from '../run-job'
import {
  EXPORT_RETRY_DELAY_MAX_SECONDS,
  exportDocument,
  exportDocumentRetry,
} from '../jobs/export-document'
import { pollStorageChanges } from '../jobs/poll-storage-changes'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Write-through (§6) end to end: an in-app upload on a record whose binding
 * pushes, born by core's birth and exported by `storage.export` through the
 * real google-drive (and box) bundle against the mutable fake.
 * - The next poll reads our own write as no change: no download, no row.
 * - Deleting it here leaves theirs and tombstones it.
 * - A refused token waits, counted; restored, it drains.
 * - Pull-only bindings, integration arrivals and notes export nothing.
 */

type Sent = {
  readonly queue: string
  readonly data: Record<string, unknown>
  readonly singletonKey: string | undefined
}

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
  await db.delete(link).where(eq(link.relation, 'tagged_in'))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

const aRecord = async (kind: 'deal' | 'note', name: string) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no record')
  return row.id
}

const aConnection = async (provider: 'google' | 'box') => {
  const userId = FIXTURE_ACTOR.id
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider,
        product: provider === 'google' ? 'drive' : 'box',
        externalEmail: `${randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          {
            accessToken: 'unused',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
          },
          { userId, provider },
        ),
        scopes:
          provider === 'google'
            ? ['openid', 'email', 'drive.file', 'drive.readonly']
            : ['root_readwrite'],
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
    isFinalAttempt: false,
  })

type Wired = {
  readonly sent: Array<Sent>
  readonly recording: Layer.Layer<Enqueue>
  readonly poll: () => Promise<Exit.Exit<JobResult, JobFailure>>
  readonly exportOf: (
    documentId: string,
  ) => Promise<Exit.Exit<JobResult, JobFailure>>
}

/** A storage-source bundle wired over a fake API, with a recording `Enqueue`. */
const wire = async (
  pluginId: 'google-drive' | 'box',
  standIn: { fetch: FakeDriveApi['fetch']; accessToken: string },
  config: { folderId: string },
): Promise<Wired> => {
  const root = pluginsRootWith(`export-${pluginId}`, [pluginId])
  await db.insert(integration).values({
    capabilityId: pluginId,
    version: '0.1.0',
    enabled: true,
    config,
  })
  const fakes: FakeProviders = {
    standIn: (id) =>
      id === pluginId ? { ...standIn, secret: `fake-${pluginId}-key` } : null,
  }
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: pluginId, fakes }),
  )
  const host = makePluginHost({ enqueue: NoEnqueue, fakes })
  hosts.push(host)
  await Effect.runPromise(host.wire(loaded))
  const sent: Array<Sent> = []
  const recording = Layer.succeed(
    Enqueue,
    Enqueue.of({
      enqueue: (queue, data, options) =>
        Effect.sync(() => {
          sent.push({ queue, data, singletonKey: options?.singletonKey })
          return `job-${String(sent.length)}`
        }),
    }),
  )
  const layer = Layer.mergeAll(
    storageSourcesLayer(host, { fakes, pluginsRoot: root }),
    recording,
    pluginBreakerLayer(host),
  )
  return {
    sent,
    recording,
    poll: () =>
      Effect.runPromiseExit(
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
    exportOf: (documentId) =>
      Effect.runPromiseExit(
        exportDocument
          .run({ documentId })
          .pipe(
            Effect.provide(layer),
            Effect.provideService(JobContext, context(QUEUES.exportDocument)),
          ),
      ),
  }
}

const wiredDrive = async () => {
  const api = makeFakeDriveApi()
  const wired = await wire('google-drive', api, { folderId: 'dataroom' })
  return { api, ...wired }
}

const ROOM = {
  folderId: 'dataroom',
  ancestorIds: ['root'],
  path: 'My Drive / Acme Data Room',
}

const PUSH: BindingOptions = {
  mapSubfolders: false,
  retain: 'full',
  direction: 'push',
  sensitivity: 'inherit',
}

const bind = async (
  connectionId: string,
  deal: string,
  folder: { folderId: string; ancestorIds: Array<string>; path: string },
  direction: BindingOptions['direction'],
  provider: 'google' | 'box' = 'google',
) =>
  (
    await Effect.runPromise(
      bindFolderProgram({
        connectionId,
        provider,
        folder,
        targetEntityId: deal,
        boundBy: FIXTURE_ACTOR.id,
        options: { ...PUSH, direction },
      }),
    )
  ).id

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const failure = (exit: Exit.Exit<JobResult, JobFailure>): JobFailure => {
  if (Exit.isSuccess(exit)) throw new Error(`succeeded: ${String(exit.value)}`)
  const found = exit.cause.reasons.find(Cause.isFailReason)
  if (found === undefined) throw new Error(Cause.pretty(exit.cause))
  return found.error
}

/** Every binding past the poll's minimum interval. */
const age = () =>
  db
    .update(storageBinding)
    .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(storageBinding.id))

/** The upload a person makes on a Files tab: bytes stored, then birth. */
const upload = async (
  wired: Wired,
  filename: string,
  content: string,
  fileOn: string,
  arrival: {
    sourceClass: SourceClass
    sourceRef: string | null
    url?: string
  } = {
    sourceClass: 'manual',
    sourceRef: null,
  },
) => {
  const bytes = Buffer.from(content)
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'application/pdf' })
  const born = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: sha,
      filename,
      ...(arrival.url === undefined ? {} : { url: arrival.url }),
      mime: 'application/pdf',
      sizeBytes: bytes.length,
      kind: 'deck',
      sourceClass: arrival.sourceClass,
      sourceRef: arrival.sourceRef,
      provenance: {},
      fileAgainst: [{ kind: 'record', entityId: fileOn }],
      actor:
        arrival.sourceRef === null
          ? { userId: FIXTURE_ACTOR.id }
          : { integrationId: arrival.sourceRef },
    }).pipe(Effect.provide(wired.recording)),
  )
  return born.id
}

const rowOf = async (documentId: string) => {
  const row = (
    await db
      .select({
        bindingId: document.bindingId,
        connectionId: document.connectionId,
        externalId: document.externalId,
        externalStatus: document.externalStatus,
        externalRevisionId: document.externalRevisionId,
        sourcePath: document.sourcePath,
        filename: document.filename,
      })
      .from(document)
      .where(eq(document.entityId, documentId))
  ).at(0)
  if (row === undefined) throw new Error(`no document ${documentId}`)
  return row
}

const exportedId = async (documentId: string) => {
  const { externalId } = await rowOf(documentId)
  if (externalId === null) throw new Error('not exported')
  return externalId
}

const documentCount = async () => (await db.select().from(document)).length

const exportsSent = (sent: ReadonlyArray<Sent>) =>
  sent.filter((s) => s.queue === QUEUES.exportDocument)

/** Drive requests that read a file's bytes. */
const downloads = (api: FakeDriveApi) =>
  api.requests.filter(
    (r) => r.query.alt === 'media' || r.path.endsWith('/export'),
  ).length

const writesTo = (api: FakeDriveApi) =>
  api.requests.filter((r) => r.method !== 'GET')

const waiting = () => Effect.runPromise(waitingExportsProgram())

/** The Files tab's file and unfile: the app's own re-file. */
const fileOn = async (documentId: string, entityId: string) => {
  const { fileDocumentProgram } = await import('#web/lib/documents/refile')
  await Effect.runPromise(
    fileDocumentProgram(FIXTURE_ACTOR.id, {
      documentId,
      target: { kind: 'record', entityId },
    }),
  )
}

const unfileFrom = async (documentId: string, entityId: string) => {
  const { unfileDocumentProgram } = await import('#web/lib/documents/refile')
  await Effect.runPromise(
    unfileDocumentProgram(FIXTURE_ACTOR.id, {
      documentId,
      target: { kind: 'record', entityId },
    }),
  )
}

const deleteInApp = async (documentId: string) => {
  const { deleteDocumentWithBlobGc } = await import('#web/lib/server/shared')
  await deleteDocumentWithBlobGc(documentId)
}

/** A deal bound push to the data room, the poll's cursor started. */
const pushedRoom = async (direction: BindingOptions['direction'] = 'push') => {
  const drive = await wiredDrive()
  const connectionId = await aConnection('google')
  const deal = await aRecord('deal', 'Acme')
  const bindingId = await bind(
    connectionId,
    deal,
    { ...ROOM, ancestorIds: [...ROOM.ancestorIds] },
    direction,
  )
  expect(String(succeeded(await drive.poll()))).toMatch(/cursor started$/)
  return { drive, connectionId, deal, bindingId }
}

describe('storage.export: write-through (§6)', () => {
  it('uploading deck.pdf on a deal bound push lands in the bound folder, records external_id, and the next poll creates no second document', async () => {
    const { drive, connectionId, deal, bindingId } = await pushedRoom()
    const id = await upload(drive, 'deck.pdf', '%PDF-1.7 our deck', deal)

    expect(exportsSent(drive.sent)).toEqual([
      {
        queue: QUEUES.exportDocument,
        data: { documentId: id },
        singletonKey: id,
      },
    ])
    expect(await rowOf(id)).toMatchObject({ bindingId, externalId: null })
    expect(await waiting()).toEqual([{ provider: 'google', count: 1 }])

    expect(String(succeeded(await drive.exportOf(id)))).toMatch(/^exported as /)
    const fileId = await exportedId(id)
    const entry = drive.api.drive.entry(fileId)
    expect(entry).toMatchObject({ name: 'deck.pdf', parentId: 'dataroom' })
    expect(await rowOf(id)).toEqual({
      bindingId,
      connectionId,
      externalId: fileId,
      externalStatus: 'linked',
      externalRevisionId: entry?.changeToken,
      sourcePath: ROOM.path,
      filename: 'deck.pdf',
    })
    expect(await waiting()).toEqual([])

    // The poll that sees our own write: no download, no revision, no row.
    const count = await documentCount()
    const read = downloads(drive.api)
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 1 ignored, 0 outside, 0 revised$/,
    )
    expect(downloads(drive.api)).toBe(read)
    expect(await documentCount()).toBe(count)

    // A second run of the job sends nothing new.
    const writes = writesTo(drive.api).length
    expect(String(succeeded(await drive.exportOf(id)))).toBe('already in place')
    expect(writesTo(drive.api)).toHaveLength(writes)
  })

  it('deleting that document in the app leaves the provider file intact and writes a tombstone, so no poll re-imports it', async () => {
    const { drive, connectionId, deal, bindingId } = await pushedRoom()
    const id = await upload(drive, 'deck.pdf', '%PDF-1.7 our deck', deal)
    succeeded(await drive.exportOf(id))
    const fileId = await exportedId(id)
    const writes = writesTo(drive.api).length

    await deleteInApp(id)
    expect(
      await db
        .select({
          bindingId: storageTombstone.bindingId,
          externalId: storageTombstone.externalId,
        })
        .from(storageTombstone),
    ).toEqual([{ bindingId, externalId: fileId }])
    expect(drive.api.drive.entry(fileId)).toBeDefined()
    expect(writesTo(drive.api)).toHaveLength(writes)

    const count = await documentCount()
    drive.api.drive.edit(fileId, '%PDF-1.7 edited in Drive after our delete')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 1 ignored, 0 outside, 0 revised$/,
    )
    expect(await documentCount()).toBe(count)
    expect(
      await db
        .select({ id: document.entityId })
        .from(document)
        .where(
          and(
            eq(document.externalId, fileId),
            eq(document.connectionId, connectionId),
          ),
        ),
    ).toEqual([])
  })

  it('with the connection revoked the export waits with backoff and is counted; restored, it drains', async () => {
    const { drive, deal } = await pushedRoom()
    const id = await upload(drive, 'deck.pdf', '%PDF-1.7 our deck', deal)
    drive.api.drive.revoke()

    const refused = failure(await drive.exportOf(id))
    expect(refused).toBeInstanceOf(JobRetryable)
    expect(refused._tag === 'JobRetryable' ? refused.reason : '').toMatch(
      /^waiting for a Drive connection: /,
    )
    expect(await rowOf(id)).toMatchObject({ externalId: null })
    expect(await waiting()).toEqual([{ provider: 'google', count: 1 }])

    drive.api.drive.restore()
    expect(String(succeeded(await drive.exportOf(id)))).toMatch(/^exported as /)
    expect(drive.api.drive.entry(await exportedId(id))).toMatchObject({
      name: 'deck.pdf',
      parentId: 'dataroom',
    })
    expect(await waiting()).toEqual([])
  })

  it('the retry schedule waits about a day, each delay capped at an hour', () => {
    // pg-boss's backoff: delay × 2^n / 2 at least, never past the cap.
    let least = 0
    for (let n = 1; n <= exportDocumentRetry.limit; n++)
      least += Math.min(
        EXPORT_RETRY_DELAY_MAX_SECONDS,
        (exportDocumentRetry.delaySeconds * 2 ** Math.min(16, n)) / 2,
      )
    expect(exportDocumentRetry.backoff).toBe(true)
    expect(least / 3600).toBeGreaterThan(20)
    expect(least / 3600).toBeLessThan(30)
  })

  it('a record whose binding is pull-only exports nothing', async () => {
    const { drive, deal } = await pushedRoom('pull')
    const id = await upload(drive, 'deck.pdf', '%PDF-1.7 our deck', deal)
    expect(exportsSent(drive.sent)).toEqual([])
    expect(await rowOf(id)).toMatchObject({ bindingId: null, externalId: null })
    expect(await waiting()).toEqual([])
    // Sent anyway, the job finds nothing to export.
    expect(String(succeeded(await drive.exportOf(id)))).toMatch(
      /nothing exported$/,
    )
    expect(writesTo(drive.api)).toEqual([])
  })

  it('only an upload exports: an integration arrival or a capture on a bound record does not', async () => {
    const { drive, deal } = await pushedRoom()
    const plugin = (
      await db
        .select({ id: integration.id })
        .from(integration)
        .where(eq(integration.enabled, true))
    ).at(0)
    if (plugin === undefined) throw new Error('no integration')

    const attachment = await upload(
      drive,
      'attached.pdf',
      '%PDF-1.7 from mail',
      deal,
      {
        sourceClass: 'integration',
        sourceRef: plugin.id,
      },
    )
    const capture = await upload(drive, 'page.txt', 'a captured page', deal, {
      sourceClass: 'manual',
      sourceRef: null,
      url: 'https://example.com/a-page',
    })
    expect(exportsSent(drive.sent)).toEqual([])
    for (const id of [attachment, capture]) {
      expect(await rowOf(id)).toMatchObject({
        bindingId: null,
        externalId: null,
      })
      expect(String(succeeded(await drive.exportOf(id)))).toMatch(
        /nothing exported$/,
      )
    }
    expect(await waiting()).toEqual([])
    expect(writesTo(drive.api)).toEqual([])
  })

  it("notes never export; a memo's exported PDF, being a document, does", async () => {
    const { drive, deal } = await pushedRoom()
    const memo = await aRecord('note', 'Acme investment memo')
    await db.insert(link).values({
      fromEntityId: memo,
      toEntityId: deal,
      relation: 'tagged_in',
      source: 'manual',
    })
    expect(await Effect.runPromise(exportPlanOf(memo))).toBeNull()
    expect(String(succeeded(await drive.exportOf(memo)))).toMatch(
      /nothing exported$/,
    )
    expect(writesTo(drive.api)).toEqual([])

    const pdf = await upload(
      drive,
      'Acme investment memo.pdf',
      '%PDF-1.7 the memo',
      deal,
    )
    await db.insert(link).values({
      fromEntityId: pdf,
      toEntityId: memo,
      relation: 'derived_from',
      source: 'manual',
    })
    expect(exportsSent(drive.sent).map((s) => s.data)).toEqual([
      { documentId: pdf },
    ])
    succeeded(await drive.exportOf(pdf))
    expect(drive.api.drive.entry(await exportedId(pdf))).toMatchObject({
      name: 'Acme investment memo.pdf',
      parentId: 'dataroom',
    })
  })

  it('re-filing an exported document onto another pushing record of the same connection moves it there; onto an unbound record it stays', async () => {
    const { drive, connectionId, deal } = await pushedRoom()
    const other = await aRecord('deal', 'Hydrogen research')
    const research = drive.api.drive.create({
      kind: 'folder',
      name: 'Research',
      parentId: 'root',
    })
    const researchPath = 'My Drive / Research'
    const otherBinding = await bind(
      connectionId,
      other,
      { folderId: research.id, ancestorIds: ['root'], path: researchPath },
      'push',
    )
    const unbound = await aRecord('deal', 'Nobody binds this')
    const id = await upload(drive, 'deck.pdf', '%PDF-1.7 our deck', deal)
    succeeded(await drive.exportOf(id))
    const fileId = await exportedId(id)

    // Onto an unbound record, then off the bound one: nowhere to move it.
    // Each app re-file of a pushed upload sends the export; the stub keeps a
    // keyed job queued, so it is read and cleared as the worker would run it.
    const sentExport = () => {
      const keys = enqueued
        .filter((e) => e.name === QUEUES.exportDocument)
        .map((e) => e.options?.singletonKey)
      enqueued.length = 0
      return keys
    }
    await fileOn(id, unbound)
    expect(sentExport()).toEqual([id])
    await unfileFrom(id, deal)
    expect(sentExport()).toEqual([id])
    expect(String(succeeded(await drive.exportOf(id)))).toBe('already in place')
    expect(drive.api.drive.entry(fileId)?.parentId).toBe('dataroom')

    // Onto the other pushing record: moved, its pointer follows.
    await fileOn(id, other)
    await unfileFrom(id, unbound)
    expect(sentExport()).toEqual([id])
    expect(String(succeeded(await drive.exportOf(id)))).toBe(
      'moved to its new binding',
    )
    expect(drive.api.drive.entry(fileId)?.parentId).toBe(research.id)
    expect(await rowOf(id)).toMatchObject({
      bindingId: otherBinding,
      externalId: fileId,
      sourcePath: researchPath,
    })

    // The poll that sees the move (and the new folder) proposes nothing and
    // files nothing: the row already reads the file's new place.
    const count = await documentCount()
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 2 ignored, 0 outside, 0 revised$/,
    )
    expect(await documentCount()).toBe(count)
  })

  it('a rename here renames the provider file', async () => {
    const { drive, deal } = await pushedRoom()
    const id = await upload(drive, 'deck.pdf', '%PDF-1.7 our deck', deal)
    succeeded(await drive.exportOf(id))
    const fileId = await exportedId(id)
    await db
      .update(document)
      .set({ filename: 'Acme deck v2.pdf' })
      .where(eq(document.entityId, id))
    succeeded(await drive.exportOf(id))
    expect(drive.api.drive.entry(fileId)?.name).toBe('Acme deck v2.pdf')
  })

  it('an upload on a Box-bound record with direction push lands in the bound folder and the next poll creates no duplicate', async () => {
    const api = makeFakeBoxApi()
    const box = await wire('box', api, { folderId: '1001' })
    const connectionId = await aConnection('box')
    const deal = await aRecord('deal', 'Acme Series B')
    const bindingId = await bind(
      connectionId,
      deal,
      {
        folderId: '1001',
        ancestorIds: ['0'],
        path: 'All Files / Acme Data Room',
      },
      'push',
      'box',
    )
    expect(String(succeeded(await box.poll()))).toMatch(/cursor started$/)

    const id = await upload(box, 'deck.pdf', '%PDF-1.7 our deck', deal)
    expect(String(succeeded(await box.exportOf(id)))).toMatch(/^exported as /)
    const fileId = await exportedId(id)
    expect(await rowOf(id)).toMatchObject({
      bindingId,
      connectionId,
      externalStatus: 'linked',
      sourcePath: 'All Files / Acme Data Room',
    })
    const held = await db
      .select({ id: document.entityId })
      .from(document)
      .where(
        and(
          eq(document.externalId, fileId),
          eq(document.connectionId, connectionId),
        ),
      )
    expect(held).toEqual([{ id }])

    const count = await documentCount()
    await age()
    expect(String(succeeded(await box.poll()))).toMatch(
      /0 new, 0 held, 0 attached by sha, \d+ ignored, 0 outside, 0 revised$/,
    )
    expect(await documentCount()).toBe(count)
  })
})
