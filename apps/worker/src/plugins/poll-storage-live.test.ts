import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  chunk,
  document,
  entity,
  entitySpace,
  integration,
  link,
  space,
  storageBinding,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { intakeDocumentProgram } from '@spaces/core/writes/documents/intake'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  FAKE_DRIVE_RESEARCH_SEED,
  FAKE_DRIVE_SEED,
  makeFakeDriveApi,
} from '@spaces/sdk/testing'
import type {
  FakeDriveApi,
  FakeDriveSeedItem,
  FetchLike,
} from '@spaces/sdk/testing'
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

/**
 * The change poll end to end on the real google-drive bundle against the fake
 * Drive API: one `changes` pass per connection, fanned out to the bindings
 * whose subtree holds each new file, the cursor kept until a page is handled.
 * - `fetch` is wrapped per case, so a case can fail downloads mid-page.
 */

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

type Sent = {
  readonly queue: string
  readonly data: Record<string, unknown>
  readonly singletonKey: string | undefined
}

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
 * The fake API, counting downloads; past `failAfter` of them each further
 * download answers 503, which the plugin reads as a transient failure.
 */
const counted = (api: FakeDriveApi) => {
  const state = { downloads: 0, failAfter: Number.POSITIVE_INFINITY }
  const fetch: FetchLike = (url, init) => {
    if (isDownload(url)) {
      if (state.downloads >= state.failAfter)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 503, message: 'Backend Error', errors: [] },
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
        )
      state.downloads += 1
    }
    return api.fetch(url, init)
  }
  return { state, fetch }
}

/** The fake API wired as the installed Drive, with a recording `Enqueue`. */
const wiredDrive = async (
  seed = FAKE_DRIVE_SEED,
): Promise<{
  api: FakeDriveApi
  wire: ReturnType<typeof counted>
  integrationId: string
  sent: Array<Sent>
  poll: () => Promise<Exit.Exit<JobResult, JobFailure>>
}> => {
  const api = makeFakeDriveApi({ seed })
  const wire = counted(api)
  const root = pluginsRootWith('poll-storage', ['google-drive'])
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
  const poll = () =>
    Effect.runPromiseExit(
      pollStorageChanges.run({}).pipe(
        Effect.provide(layer),
        Effect.provideService(
          JobContext,
          JobContext.of({
            queue: QUEUES.pollStorageChanges,
            jobId: `test-${randomUUID()}`,
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
      ),
    )
  return { api, wire, integrationId: row.id, sent, poll }
}

const bind = async (input: {
  connectionId: string
  folderId: string
  ancestorIds: ReadonlyArray<string>
  path: string
  target: string
  mapSubfolders?: boolean
  sensitivity?: 'inherit' | 'sensitive'
}) =>
  (
    await Effect.runPromise(
      bindFolderProgram({
        connectionId: input.connectionId,
        provider: 'google',
        folder: {
          folderId: input.folderId,
          ancestorIds: [...input.ancestorIds],
          path: input.path,
        },
        targetEntityId: input.target,
        boundBy: FIXTURE_ACTOR.id,
        options: {
          mapSubfolders: input.mapSubfolders ?? false,
          retain: 'full',
          direction: 'pull',
          sensitivity: input.sensitivity ?? 'inherit',
        },
      }),
    )
  ).id

const LEGAL = {
  folderId: 'legal',
  ancestorIds: ['root', 'dataroom'],
  path: 'My Drive / Acme Data Room / 01 Legal',
}
const FINANCE = {
  folderId: 'finance',
  ancestorIds: ['root', 'dataroom'],
  path: 'My Drive / Acme Data Room / 02 Finance',
}

const aFile = (
  id: string,
  parentId: string,
  content = `%PDF-1.7 ${id}`,
): FakeDriveSeedItem => ({
  kind: 'file',
  id,
  name: `${id}.pdf`,
  parentId,
  mime: 'application/pdf',
  content,
})

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const cursorOf = async (connectionId: string) =>
  (
    await db
      .select({ cursor: accountConnection.storageCursor })
      .from(accountConnection)
      .where(eq(accountConnection.id, connectionId))
  ).at(0)?.cursor ?? null

/** Every binding past the poll's minimum interval. */
const age = () =>
  db
    .update(storageBinding)
    .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(storageBinding.id))

const byExternalId = async (externalId: string) =>
  db
    .select({
      id: document.entityId,
      bindingId: document.bindingId,
      sourcePath: document.sourcePath,
      externalStatus: document.externalStatus,
      blobSha: document.blobSha,
      kind: document.kind,
    })
    .from(document)
    .where(eq(document.externalId, externalId))

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

/** The requests one call made: the log from `from` on. */
const since = (api: FakeDriveApi, from: number) => api.requests.slice(from)

describe('storage.poll on the google-drive bundle', () => {
  it('two bindings on one drive share one changes pass; a new file in either is filed on its record, one outside neither is not', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const legalDeal = await aRecord('deal', 'Acme legal')
    const financeDeal = await aRecord('deal', 'Acme finance')
    const legal = await bind({ connectionId, ...LEGAL, target: legalDeal })
    const finance = await bind({
      connectionId,
      ...FINANCE,
      target: financeDeal,
    })

    // No cursor yet: a starting one, and no backfill.
    expect(await cursorOf(connectionId)).toBeNull()
    expect(String(succeeded(await drive.poll()))).toMatch(/cursor started/)
    const started = await cursorOf(connectionId)
    expect(started).not.toBeNull()
    const before = await documentCount()

    drive.api.drive.add(aFile('new-legal', 'legal'))
    drive.api.drive.add(aFile('new-board', 'board'))
    drive.api.drive.add(aFile('new-outside', 'dataroom'))
    await age()
    const from = drive.api.requests.length
    expect(succeeded(await drive.poll())).toBe(
      `polled 1 connections: ${connectionId}: 2 new, 0 held, 0 attached by sha, 0 ignored, 1 outside`,
    )

    const requests = since(drive.api, from)
    expect(requests.filter((r) => r.path === '/drives')).toHaveLength(1)
    expect(
      requests.filter(
        (r) => r.path === '/changes' && r.query.driveId === undefined,
      ),
    ).toHaveLength(1)

    const inLegal = (await byExternalId('new-legal')).at(0)
    expect(inLegal).toMatchObject({
      bindingId: legal,
      sourcePath: LEGAL.path,
      externalStatus: 'linked',
    })
    expect(await taggedIn(inLegal?.id ?? '')).toEqual([legalDeal])
    const inBoard = (await byExternalId('new-board')).at(0)
    expect(inBoard).toMatchObject({
      bindingId: finance,
      sourcePath: `${FINANCE.path} / Board`,
    })
    expect(await taggedIn(inBoard?.id ?? '')).toEqual([financeDeal])
    expect(await byExternalId('new-outside')).toEqual([])
    expect(await documentCount()).toBe(before + 2)
    expect(await cursorOf(connectionId)).not.toBe(started)

    // Inside the minimum interval nothing is asked of the provider.
    const quiet = drive.api.requests.length
    expect(succeeded(await drive.poll())).toBe('no binding due')
    expect(drive.api.requests).toHaveLength(quiet)
  })

  it('a page of ten new files in one folder reads that folder’s ancestry once', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme finance')
    await bind({ connectionId, ...FINANCE, target: deal })
    succeeded(await drive.poll())

    for (let i = 0; i < 10; i++)
      drive.api.drive.add(aFile(`board-${String(i)}`, 'board'))
    await age()
    const from = drive.api.requests.length
    expect(String(succeeded(await drive.poll()))).toMatch(/: 10 new, /)

    const reads = (id: string) =>
      since(drive.api, from).filter((r) => r.path === `/files/${id}`)
    for (const folder of ['board', 'finance', 'dataroom', 'root'])
      expect(reads(folder), folder).toHaveLength(1)
  })

  it('a poll cut short mid-page keeps the old cursor, and the replay files the rest once', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme legal')
    const legal = await bind({ connectionId, ...LEGAL, target: deal })
    succeeded(await drive.poll())
    const cursor = await cursorOf(connectionId)

    const ids = ['a', 'b', 'c', 'd', 'e'].map((x) => `cut-${x}`)
    for (const id of ids) drive.api.drive.add(aFile(id, 'legal'))
    drive.wire.state.failAfter = 2
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/rate limited/)
    expect(await cursorOf(connectionId)).toBe(cursor)
    const filedFirst = (
      await db
        .select({ id: document.entityId })
        .from(document)
        .where(eq(document.bindingId, legal))
    ).length
    expect(filedFirst).toBe(2)

    drive.wire.state.failAfter = Number.POSITIVE_INFINITY
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 3 new, 0 held, 0 attached by sha, 2 ignored, 0 outside/,
    )
    for (const id of ids) expect(await byExternalId(id)).toHaveLength(1)
    // Nothing filed in the first pass was downloaded again.
    expect(drive.wire.state.downloads).toBe(5)
    expect(await cursorOf(connectionId)).not.toBe(cursor)
  })

  it('an edit to a held file and a removal are ignored, not mishandled', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme legal')
    await bind({ connectionId, ...LEGAL, target: deal })
    succeeded(await drive.poll())
    drive.api.drive.add(aFile('kept', 'legal'))
    await age()
    succeeded(await drive.poll())
    const held = (await byExternalId('kept')).at(0)
    const downloads = drive.wire.state.downloads
    const count = await documentCount()

    drive.api.drive.edit('kept', '%PDF-1.7 kept, edited')
    drive.api.drive.remove('spa')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 2 ignored, 0 outside/,
    )
    expect(await documentCount()).toBe(count)
    expect(drive.wire.state.downloads).toBe(downloads)
    expect(await byExternalId('kept')).toEqual([held])
  })

  it('an expired cursor re-syncs every binding on the connection and stores a fresh cursor', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const legal = await bind({
      connectionId,
      ...LEGAL,
      target: await aRecord('deal', 'Acme legal'),
    })
    const finance = await bind({
      connectionId,
      ...FINANCE,
      target: await aRecord('deal', 'Acme finance'),
    })
    succeeded(await drive.poll())
    const expired = await cursorOf(connectionId)

    drive.api.drive.evictCursors()
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /cursor expired, 2 bindings re-synced$/,
    )
    expect(drive.sent).toEqual([
      {
        queue: QUEUES.syncStorageBinding,
        data: { bindingId: legal },
        singletonKey: legal,
      },
      {
        queue: QUEUES.syncStorageBinding,
        data: { bindingId: finance },
        singletonKey: finance,
      },
    ])
    expect(await cursorOf(connectionId)).not.toBe(expired)

    // The fresh cursor reads on.
    drive.api.drive.add(aFile('after-expiry', 'legal'))
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/: 1 new, /)
  })

  it('a refused token marks the connection’s bindings and keeps the cursor', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const legal = await bind({
      connectionId,
      ...LEGAL,
      target: await aRecord('deal', 'Acme legal'),
    })
    succeeded(await drive.poll())
    const cursor = await cursorOf(connectionId)

    drive.api.drive.revoke()
    await age()
    succeeded(await drive.poll())
    const row = (
      await db
        .select({ status: storageBinding.status, error: storageBinding.error })
        .from(storageBinding)
        .where(eq(storageBinding.id, legal))
    ).at(0)
    expect(row?.status).toBe('error')
    expect(row?.error).toMatch(/Invalid Credentials/)
    expect(await cursorOf(connectionId)).toBe(cursor)
  })

  it('a new file deep in a mapped space files where the walk would put it', async () => {
    const drive = await wiredDrive([
      ...FAKE_DRIVE_SEED,
      ...FAKE_DRIVE_RESEARCH_SEED,
    ])
    const connectionId = await aConnection()
    const spaceId = (
      await db
        .insert(entity)
        .values({ kind: 'space', canonicalName: 'Hydrogen' })
        .returning({ id: entity.id })
    ).at(0)?.id
    if (spaceId === undefined) throw new Error('no space')
    await db
      .insert(space)
      .values({ entityId: spaceId, slug: 'poll-h2', path: 'poll_h2' })
    const { entityId: company } = await resolveEntity({
      kind: 'company',
      name: 'Ohmium',
      source: { class: 'manual' },
    })
    const deal = await aRecord('deal', 'Ohmium Series B')
    await db.insert(link).values({
      fromEntityId: deal,
      toEntityId: company,
      relation: 'references',
      attrSlug: 'company',
    })
    await bind({
      connectionId,
      folderId: 'hydrogen',
      ancestorIds: ['root', 'research'],
      path: 'My Drive / Research / Hydrogen',
      target: spaceId,
      mapSubfolders: true,
    })
    succeeded(await drive.poll())

    drive.api.drive.add(aFile('poll-terms', 'ohmium-series-b'))
    drive.api.drive.add(aFile('poll-room', 'ohmium-dataroom'))
    drive.api.drive.add(aFile('poll-loose', 'hydrogen'))
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/: 3 new, /)

    const terms = (await byExternalId('poll-terms')).at(0)
    expect(terms?.sourcePath).toBe(
      'My Drive / Research / Hydrogen / Ohmium / Ohmium Series B',
    )
    expect(await taggedIn(terms?.id ?? '')).toEqual([deal])
    const room = (await byExternalId('poll-room')).at(0)
    expect(room?.kind).toBe('dd')
    expect(await taggedIn(room?.id ?? '')).toEqual([company])
    const loose = (await byExternalId('poll-loose')).at(0)
    const inSpace = await db
      .select({ spaceId: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, loose?.id ?? ''))
    expect(inSpace).toEqual([{ spaceId }])
  })

  it('a file whose bytes are already on a sensitive binding’s record attaches and stamps that document’s chunks', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme legal')
    const legal = await bind({
      connectionId,
      ...LEGAL,
      target: deal,
      sensitivity: 'sensitive',
    })
    const content = '%PDF-1.7 already uploaded'
    const uploaded = await Effect.runPromise(
      intakeDocumentProgram({
        stream: Readable.from([Buffer.from(content)]),
        filename: 'Uploaded.pdf',
        mime: 'application/pdf',
        declaredSize: null,
        kind: 'legal',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'record', entityId: deal }],
        actor: { userId: FIXTURE_ACTOR.id },
      }).pipe(Effect.provide(NoEnqueue)),
    )
    await db.insert(chunk).values(
      [0, 1].map((idx): typeof chunk.$inferInsert => ({
        entityId: uploaded.id,
        sourceKind: 'document',
        sourceKey: '',
        idx,
        text: `uploaded page ${String(idx)}`,
      })),
    )
    succeeded(await drive.poll())

    drive.api.drive.add(aFile('same-bytes', 'legal', content))
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 1 attached by sha, /,
    )
    expect(await byExternalId('same-bytes')).toMatchObject([
      { id: uploaded.id, bindingId: legal },
    ])
    const stamps = await db
      .select({ sensitive: chunk.sensitive })
      .from(chunk)
      .where(eq(chunk.entityId, uploaded.id))
    expect(stamps).toEqual([{ sensitive: true }, { sensitive: true }])
  })
})
