import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  company,
  document,
  entity,
  integration,
  link,
  pendingBlob,
} from '@spaces/db/schema'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { storage } from '@spaces/core/writes/storage'
import { FAKE_DRIVE_SEED, makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveApi } from '@spaces/sdk/testing'
import { minimalPdf } from '#web/test/minimal-pdf'
import { enqueue as stubSend } from '#web/test/queue-stub'
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
import { ExtractionStore, extractDocument } from '../jobs/extract-document'
import { FETCH_REFUSALS, fetchStorageFile } from '../jobs/fetch-storage-file'
import type { FetchStorageFileData } from '../jobs/fetch-storage-file'

/**
 * A pasted Drive link, end to end on the real google-drive bundle against
 * the fake Drive API: resolve, the held-file check, the streamed fetch
 * through intake, and the extraction that makes a phrase findable.
 * - `fakes` stands the API in, as `SPACES_FAKE_PROVIDERS=1` does.
 * - One case runs with the fakes off and the API as plain transport, so the
 *   token Drive sees is the pasting user's own connection (D66).
 */

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const PHRASE = 'Ohmium electrolyser stack warranty'

const PDF_ITEM = {
  kind: 'file',
  id: 'pitch',
  name: 'Pitch.pdf',
  parentId: 'legal',
  mime: 'application/pdf',
  content: minimalPdf(PHRASE).toString('latin1'),
} as const

const linkTo = (id: string) => `https://drive.google.com/file/d/${id}/view`

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

beforeEach(async () => {
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  const { enqueued } = await import('#web/test/queue-stub')
  enqueued.length = 0
})

const aCompany = async (name: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (ent === undefined) throw new Error('no entity')
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

const aConnection = async (
  accessToken: string,
  over: {
    userId?: string
    status?: 'active' | 'error'
    errorReason?: string
  } = {},
) => {
  const userId = over.userId ?? FIXTURE_ACTOR.id
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'google',
        product: 'drive',
        externalEmail: `${randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          { accessToken, refreshToken: 'refresh', tokenType: 'Bearer' },
          { userId, provider: 'google' },
        ),
        scopes: ['openid', 'email', 'drive.file'],
        expiresAt: new Date(Date.now() + 3_600_000),
        status: over.status ?? 'active',
        errorReason: over.errorReason ?? null,
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

/** The google-drive bundle loaded and wired on a row, and the job's Layer over it. */
const wiredDrive = async (
  api: FakeDriveApi,
  options: { fakesOn: boolean; rowConnectionId?: string },
) => {
  const root = pluginsRootWith('fetch-storage', ['google-drive'])
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'google-drive',
        version: '0.1.0',
        enabled: true,
        config: { folderId: 'dataroom' },
        connectionId: options.rowConnectionId ?? null,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (row === undefined) throw new Error('no integration')
  const fakes = options.fakesOn ? standInWith(api) : null
  const { loaded, verdicts } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: 'google-drive', fakes }),
  )
  expect(verdicts.map((v) => v.status)).toEqual(['enabled'])
  const host = makePluginHost({ enqueue: NoEnqueue, fakes })
  hosts.push(host)
  await Effect.runPromise(host.wire(loaded))
  const layer = Layer.merge(
    storageSourcesLayer(host, {
      fakes,
      pluginsRoot: root,
      ...(options.fakesOn ? {} : { fetch: api.fetch }),
    }),
    Enqueue.fromSender({ enqueue: stubSend }),
  )
  return { integrationId: row.id, layer }
}

const run = (
  data: FetchStorageFileData,
  layer: Layer.Layer<Enqueue | StorageSources>,
) =>
  Effect.runPromiseExit(
    fetchStorageFile.run(data).pipe(
      Effect.provide(layer),
      Effect.provideService(
        JobContext,
        JobContext.of({
          queue: QUEUES.fetchStorageFile,
          jobId: `test-${randomUUID()}`,
          attempt: 1,
          isFinalAttempt: true,
        }),
      ),
    ),
  )

/** The job's typed failure; throws when it succeeded or died. */
const failureOf = (exit: Exit.Exit<unknown, JobFailure>): JobFailure => {
  if (Exit.isSuccess(exit)) throw new Error('the job succeeded')
  const found = Cause.findErrorOption(exit.cause)
  if (found._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  return found.value
}

const downloads = (api: FakeDriveApi) =>
  api.requests.filter(
    (r) => r.query.alt === 'media' || r.path.endsWith('/export'),
  ).length

const documentsFor = (connectionId: string) =>
  db
    .select({
      id: document.entityId,
      blobSha: document.blobSha,
      filename: document.filename,
      sourcePath: document.sourcePath,
      externalId: document.externalId,
      externalUrl: document.externalUrl,
      connectionId: document.connectionId,
      sourceClass: document.sourceClass,
      sourceRef: document.sourceRef,
      uploadedBy: document.uploadedBy,
    })
    .from(document)
    .where(eq(document.connectionId, connectionId))

const filedOn = async (documentId: string, recordId: string) =>
  (
    await db
      .select({ id: link.id })
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, documentId),
          eq(link.toEntityId, recordId),
          eq(link.relation, 'tagged_in'),
        ),
      )
  ).length

describe('document.fetch-storage on the google-drive bundle', () => {
  it('files a pasted PDF once, with its provenance, and a second paste downloads nothing', async () => {
    const api = makeFakeDriveApi({ seed: [...FAKE_DRIVE_SEED, PDF_ITEM] })
    const { integrationId, layer } = await wiredDrive(api, { fakesOn: true })
    const connectionId = await aConnection('unused-under-fakes')
    const deal = await aCompany(`Ohmium ${randomUUID().slice(0, 6)}`)
    const data = {
      url: linkTo('pitch'),
      connectionId,
      attachTo: deal,
      actorUserId: FIXTURE_ACTOR.id,
    }

    const first = await run(data, layer)
    expect(Exit.isSuccess(first)).toBe(true)
    const rows = await documentsFor(connectionId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      filename: 'Pitch.pdf',
      sourcePath: 'My Drive / Acme Data Room / 01 Legal',
      externalId: 'pitch',
      externalUrl: 'https://drive.google.com/file/d/pitch/view',
      connectionId,
      sourceClass: 'integration',
      sourceRef: integrationId,
      uploadedBy: FIXTURE_ACTOR.id,
    })
    expect(await filedOn(row.id, deal)).toBe(1)
    const { enqueued } = await import('#web/test/queue-stub')
    expect(enqueued).toEqual([
      { name: QUEUES.extractDocument, data: { documentId: row.id } },
    ])

    // The same link again, here and on another record: no second download.
    const second = await run(data, layer)
    expect(Exit.isSuccess(second)).toBe(true)
    const other = await aCompany(`Other ${randomUUID().slice(0, 6)}`)
    const third = await run({ ...data, attachTo: other }, layer)
    expect(Exit.isSuccess(third)).toBe(true)
    expect(downloads(api)).toBe(1)
    expect(await documentsFor(connectionId)).toHaveLength(1)
    expect(await filedOn(row.id, other)).toBe(1)

    // Extraction over the fetched bytes is what Cmd-K's lexical lane reads.
    await Effect.runPromise(
      extractDocument.run({ documentId: row.id }).pipe(
        Effect.provide(ExtractionStore.layer),
        Effect.provideService(
          JobContext,
          JobContext.of({
            queue: QUEUES.extractDocument,
            jobId: 'test-extract',
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
      ),
    )
    const extracted = (
      await db
        .select({
          status: document.extractionStatus,
          text: document.extractedText,
          hit: sql<boolean>`${document.tsv} @@ plainto_tsquery('english', ${PHRASE})`,
        })
        .from(document)
        .where(eq(document.entityId, row.id))
    ).at(0)
    expect(extracted?.status).toBe('done')
    expect(extracted?.text).toContain(PHRASE)
    expect(extracted?.hit).toBe(true)

    if (row.blobSha !== null) await storage().delete(row.blobSha)
  })

  it('refuses a file past MAX_UPLOAD_BYTES on the stream, storing nothing', async () => {
    const chunkSize = 1024 * 1024
    const api = makeFakeDriveApi({
      largeFiles: [
        {
          id: 'huge',
          name: 'Data room scan.pdf',
          parentId: 'legal',
          mime: 'application/pdf',
          size: MAX_UPLOAD_BYTES + chunkSize,
          chunkSize,
        },
      ],
    })
    const { layer } = await wiredDrive(api, { fakesOn: true })
    const connectionId = await aConnection('unused-under-fakes')
    const deal = await aCompany('Huge Co')
    const failure = failureOf(
      await run(
        {
          url: linkTo('huge'),
          connectionId,
          attachTo: deal,
          actorUserId: FIXTURE_ACTOR.id,
        },
        layer,
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'JobPermanent',
      reason: `Larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
    })
    expect(await documentsFor(connectionId)).toHaveLength(0)
    expect(await db.select().from(pendingBlob)).toHaveLength(0)
  })

  it('fetches a native Doc as its export', async () => {
    const api = makeFakeDriveApi()
    const { layer } = await wiredDrive(api, { fakesOn: true })
    const connectionId = await aConnection('unused-under-fakes')
    const deal = await aCompany('Memo Co')
    const exit = await run(
      {
        url: 'https://docs.google.com/document/d/memo/edit',
        connectionId,
        attachTo: deal,
        actorUserId: FIXTURE_ACTOR.id,
      },
      layer,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    const rows = await documentsFor(connectionId)
    expect(rows.map((r) => [r.filename, r.externalId, r.sourcePath])).toEqual([
      ['Investment memo.docx', 'memo', 'My Drive / Acme Data Room'],
    ])
    expect(api.exports()).toBe(1)
  })

  it('refuses a folder, a foreign link and a file nobody shared, in words', async () => {
    const api = makeFakeDriveApi()
    const { layer } = await wiredDrive(api, { fakesOn: true })
    const connectionId = await aConnection('unused-under-fakes')
    const deal = await aCompany('Refusals Co')
    const reasonFor = async (url: string) => {
      const failure = failureOf(
        await run(
          { url, connectionId, attachTo: deal, actorUserId: FIXTURE_ACTOR.id },
          layer,
        ),
      )
      expect(failure._tag).toBe('JobPermanent')
      return 'reason' in failure ? failure.reason : ''
    }
    expect(
      await reasonFor('https://drive.google.com/drive/folders/dataroom'),
    ).toBe(FETCH_REFUSALS.folder)
    expect(await reasonFor('https://www.dropbox.com/sh/abc/AAA?dl=0')).toBe(
      FETCH_REFUSALS.notAFile,
    )
    expect(await reasonFor(linkTo('never-seeded'))).toBe(
      FETCH_REFUSALS.notFound,
    )
    expect(await documentsFor(connectionId)).toHaveLength(0)
    expect(downloads(api)).toBe(0)
  })

  it('surfaces the provider’s reason when the connection is refused', async () => {
    const api = makeFakeDriveApi()
    const { layer } = await wiredDrive(api, { fakesOn: true })
    const connectionId = await aConnection('unused-under-fakes')
    const deal = await aCompany('Revoked Co')
    api.drive.revoke()
    const failure = failureOf(
      await run(
        {
          url: linkTo('deck'),
          connectionId,
          attachTo: deal,
          actorUserId: FIXTURE_ACTOR.id,
        },
        layer,
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'JobPermanent',
      reason: 'Invalid Credentials',
    })
  })

  it('answers with the pasting user’s connection, not the row’s', async () => {
    const api = makeFakeDriveApi({ seed: [...FAKE_DRIVE_SEED, PDF_ITEM] })
    const rowConnection = await aConnection('somebody-elses-token')
    const { layer } = await wiredDrive(api, {
      fakesOn: false,
      rowConnectionId: rowConnection,
    })
    const deal = await aCompany('Grant Co')
    const mine = await aConnection(api.accessToken)
    const ok = await run(
      {
        url: linkTo('pitch'),
        connectionId: mine,
        attachTo: deal,
        actorUserId: FIXTURE_ACTOR.id,
      },
      layer,
    )
    expect(Exit.isSuccess(ok)).toBe(true)
    expect(await documentsFor(mine)).toHaveLength(1)

    // A connection in error answers with its stored reason, and Drive is never asked.
    const asked = api.requests.length
    const broken = await aConnection(api.accessToken, {
      status: 'error',
      errorReason: 'invalid_grant: Token has been expired or revoked.',
    })
    const failure = failureOf(
      await run(
        {
          url: linkTo('deck'),
          connectionId: broken,
          attachTo: deal,
          actorUserId: FIXTURE_ACTOR.id,
        },
        layer,
      ),
    )
    expect(failure._tag).toBe('JobPermanent')
    expect('reason' in failure ? failure.reason : '').toContain(
      'invalid_grant: Token has been expired or revoked.',
    )
    expect(api.requests.length).toBe(asked)
  })

  it('refuses when no storage source is installed, or the connection is not the user’s', async () => {
    const api = makeFakeDriveApi()
    const { layer } = await wiredDrive(api, { fakesOn: true })
    const deal = await aCompany('Nothing Co')
    const connectionId = await aConnection('unused-under-fakes')
    const gone = failureOf(
      await run(
        {
          url: linkTo('deck'),
          connectionId: randomUUID(),
          attachTo: deal,
          actorUserId: FIXTURE_ACTOR.id,
        },
        layer,
      ),
    )
    expect(gone).toMatchObject({ reason: FETCH_REFUSALS.connectionGone })

    await db
      .update(integration)
      .set({ enabled: false })
      .where(isNotNull(integration.id))
    const none = failureOf(
      await run(
        {
          url: linkTo('deck'),
          connectionId,
          attachTo: deal,
          actorUserId: FIXTURE_ACTOR.id,
        },
        layer,
      ),
    )
    expect(none).toMatchObject({
      reason: 'no storage-source plugin is installed for google',
    })
  })
})
