import { createHash, randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
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
  suggestion,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { entitySearchRows } from '@spaces/core/writes/read/entity-search'
import { lexicalRowsProgram } from '@spaces/core/writes/read/search'
import { storage } from '@spaces/core/writes/storage'
import { verifyBlobToken } from '@spaces/core/writes/storage/local'
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
import { ExtractionStore, extractDocument } from '../jobs/extract-document'
import { pollStorageChanges } from '../jobs/poll-storage-changes'
import { syncStorageBinding } from '../jobs/sync-storage-binding'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * The change poll's gone pointers (§8) end to end on the real google-drive
 * bundle against the mutable fake Drive: a file deleted in Drive, and one
 * moved out of every bound subtree (the row §8 leaves open, decided the same
 * way), keep our copy and are marked `external_status = 'gone'`.
 * - Nothing is deleted at the provider and nothing is proposed.
 * - A gone row never tracks again: a later page or a re-sync walk naming
 *   the same external id flips nothing and files nothing.
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
  const root = pluginsRootWith('poll-storage-gone', ['google-drive'])
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

const LEGAL_PATH = `${ROOM.path} / 01 Legal`

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

const revisionsOf = (documentId: string) =>
  db
    .select({ blobSha: documentRevision.blobSha })
    .from(documentRevision)
    .where(eq(documentRevision.documentId, documentId))

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

const proposals = () => db.select({ id: suggestion.id }).from(suggestion)

/** The data room bound to a deal, its cursor started and its walk done. */
const syncedRoom = async (extra: ReadonlyArray<FakeDriveSeedItem> = []) => {
  const drive = await wiredDrive([...FAKE_DRIVE_SEED, ...extra])
  const connectionId = await aConnection()
  const deal = await aRecord('deal', 'Acme')
  const bindingId = (
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
  succeeded(await drive.poll())
  succeeded(await drive.sync(bindingId))
  return { drive, connectionId, deal, bindingId }
}

describe('storage.poll: gone pointers (§8)', () => {
  it('§8 deleted in Drive: keep ours, external_status gone, we never delete theirs', async () => {
    const { drive, connectionId, deal, bindingId } = await syncedRoom()
    const deck = await heldOne('deck', connectionId)
    expect(deck.externalStatus).toBe('linked')
    const count = await documentCount()
    const writes = writesTo(drive.api).length
    const extracted = drive.sent.filter(
      (s) => s.queue === QUEUES.extractDocument,
    ).length

    drive.api.drive.remove('deck')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 0 ignored, 0 outside, 0 revised, 1 gone$/,
    )

    // Ours: the row, its binding, its blob and its filing, only the status moved.
    expect(await byExternalId('deck', connectionId)).toEqual([
      { ...deck, externalStatus: 'gone' },
    ])
    expect(deck.bindingId).toBe(bindingId)
    if (deck.blobSha === null) throw new Error('the deck has no blob')
    expect(await storage().exists(deck.blobSha)).toBe(true)
    expect(await taggedIn(deck.id)).toEqual([deal])
    expect(await documentCount()).toBe(count)
    expect(await revisionsOf(deck.id)).toEqual([])
    expect(
      drive.sent.filter((s) => s.queue === QUEUES.extractDocument),
    ).toHaveLength(extracted)
    // Theirs: no write of any kind was sent, and nothing was proposed.
    expect(writesTo(drive.api)).toHaveLength(writes)
    expect(await proposals()).toEqual([])
  })

  it('§8 moved out of the bound subtree (decided here as gone): the copy kept, tracking stops, nothing deleted', async () => {
    const { drive, connectionId, deal } = await syncedRoom()
    const spa = await heldOne('spa', connectionId)
    expect(spa.sourcePath).toBe(LEGAL_PATH)
    const count = await documentCount()
    const writes = writesTo(drive.api).length

    drive.api.drive.move('spa', 'root')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 0 ignored, 0 outside, 0 revised, 1 gone$/,
    )

    // The path is where it last was inside the binding; the token is not read.
    expect(await byExternalId('spa', connectionId)).toEqual([
      { ...spa, externalStatus: 'gone' },
    ])
    expect(await taggedIn(spa.id)).toEqual([deal])
    expect(await documentCount()).toBe(count)
    expect(drive.api.drive.entry('spa')?.parentId).toBe('root')
    expect(writesTo(drive.api)).toHaveLength(writes)
    expect(await proposals()).toEqual([])

    // Stopped tracking: an edit where it now sits reads nothing.
    drive.api.drive.edit('spa', '%PDF-1.7 edited outside the room')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 1 ignored, 0 outside, 0 revised$/,
    )
    expect(await byExternalId('spa', connectionId)).toEqual([
      { ...spa, externalStatus: 'gone' },
    ])
    expect(await revisionsOf(spa.id)).toEqual([])
  })

  it('a gone row is never flipped back to linked: a later page and a re-sync walk naming the same external id file and change nothing', async () => {
    const { drive, connectionId, deal, bindingId } = await syncedRoom()
    const spa = await heldOne('spa', connectionId)
    drive.api.drive.move('spa', 'root')
    await age()
    succeeded(await drive.poll())
    const gone = { ...spa, externalStatus: 'gone' as const }
    expect(await byExternalId('spa', connectionId)).toEqual([gone])
    const count = await documentCount()
    const extracted = drive.sent.filter(
      (s) => s.queue === QUEUES.extractDocument,
    ).length

    // Back into the room, renamed and edited: the page names it, and nothing moves.
    drive.api.drive.move('spa', 'legal')
    drive.api.drive.rename('spa', 'SPA signed.pdf')
    drive.api.drive.edit('spa', '%PDF-1.7 signed')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 1 ignored, 0 outside, 0 revised$/,
    )
    expect(await byExternalId('spa', connectionId)).toEqual([gone])

    // The walk lists it again and leaves it untracked.
    expect(String(succeeded(await drive.sync(bindingId)))).toMatch(
      /, 1 gone, left untracked$/,
    )
    expect(await byExternalId('spa', connectionId)).toEqual([gone])
    expect(await taggedIn(spa.id)).toEqual([deal])
    expect(await documentCount()).toBe(count)
    expect(await revisionsOf(spa.id)).toEqual([])
    expect(
      drive.sent.filter((s) => s.queue === QUEUES.extractDocument),
    ).toHaveLength(extracted)

    // A removal of a row already gone is nothing more.
    drive.api.drive.remove('spa')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 1 ignored, 0 outside, 0 revised$/,
    )
    expect(await byExternalId('spa', connectionId)).toEqual([gone])
  })

  it('a gone document stays searchable and previewable from our copy', async () => {
    const text = 'Electrolyser stack economics for the Acme round'
    const { drive, connectionId } = await syncedRoom([
      {
        kind: 'file',
        id: 'econ',
        name: 'Stack economics.txt',
        parentId: 'dataroom',
        mime: 'text/plain',
        content: text,
      },
    ])
    const econ = await heldOne('econ', connectionId)
    drive.api.drive.remove('econ')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/, 1 gone$/)
    expect(drive.api.drive.entry('econ')).toBeUndefined()

    // Extraction reads our blob, never the provider's file.
    succeeded(
      await Effect.runPromiseExit(
        extractDocument
          .run({ documentId: econ.id })
          .pipe(
            Effect.provide(ExtractionStore.layer),
            Effect.provideService(JobContext, context(QUEUES.extractDocument)),
          ),
      ),
    )

    const named = await entitySearchRows(FIXTURE_ACTOR.id, {
      q: 'Stack economics',
    })
    expect(named.map((r) => r.id)).toContain(econ.id)
    const fused = await Effect.runPromise(
      lexicalRowsProgram({ userId: FIXTURE_ACTOR.id, q: 'electrolyser' }),
    )
    expect(
      fused.filter((r) => r.id === econ.id).flatMap((r) => r.sources),
    ).toContain('document')

    // The preview's URL is the blob route's, signed for our sha, and the
    // bytes it serves are the ones the provider no longer has.
    if (econ.blobSha === null) throw new Error('no blob')
    const url = new URL(await storage().getDownloadUrl(econ.blobSha, 300))
    expect(url.pathname).toBe(`/api/blob/${econ.blobSha}`)
    expect(
      verifyBlobToken(
        econ.blobSha,
        'get',
        Number(url.searchParams.get('exp')),
        url.searchParams.get('sig') ?? '',
      ),
    ).toBe(true)
    const bytes = await storage().getBytes(econ.blobSha)
    expect(new TextDecoder().decode(bytes)).toBe(text)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(econ.blobSha)
    expect(await byExternalId('econ', connectionId)).toEqual([
      { ...econ, externalStatus: 'gone' },
    ])
  })
})
