import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  integration,
  jobRun,
  space,
  storageBinding,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import {
  RECORD_GONE,
  bindFolderProgram,
} from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  FAKE_DRIVE_RESEARCH_SEED,
  FAKE_DRIVE_SEED,
  makeFakeDriveApi,
} from '@spaces/sdk/testing'
import type { FakeDriveSeedItem, FetchLike } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pluginBreakerLayer } from './breaker'
import { pluginsRootWith } from './fakes/enrichers'
import type { FakeProviders } from './fakes/switch'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { storageSourcesLayer } from './storage-source'
import { JobContext, runJob } from '../run-job'
import type { JobFailure, JobHost, JobOutcome, JobResult } from '../run-job'
import { bindStorageFolder } from '../jobs/bind-storage-folder'
import type { BindStorageFolderData } from '../jobs/bind-storage-folder'
import { exportDocument } from '../jobs/export-document'
import { pollStorageChanges } from '../jobs/poll-storage-changes'
import { syncStorageBinding } from '../jobs/sync-storage-binding'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Storage edge cases on the real google-drive bundle against the
 * mutable fake Drive: the starting cursor a bind stores, the bound record a
 * sync or export run is ledgered on, and a file the record refuses skipped
 * while the walk and the poll go on.
 * - A download can run a hook first (`onDownload`), so a case can merge a
 *   record between a folder's placement and its file's birth.
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

let spaces = 0

const aSpace = async (name: string) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no space')
  spaces += 1
  await db.insert(space).values({
    entityId: row.id,
    slug: `loose-${String(spaces)}`,
    path: `loose_${String(spaces)}`,
  })
  return row.id
}

/** A record merged into a fresh survivor: gone, as a filing sees it. */
const merge = async (entityId: string) => {
  const survivor = await aRecord('company', `Survivor ${randomUUID()}`)
  await db
    .update(entity)
    .set({ mergedIntoId: survivor })
    .where(eq(entity.id, entityId))
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

const cursorOf = async (connectionId: string) =>
  (
    await db
      .select({ cursor: accountConnection.storageCursor })
      .from(accountConnection)
      .where(eq(accountConnection.id, connectionId))
  ).at(0)?.cursor ?? null

/** The file id a `alt=media` download names, or null for any other call. */
const downloadOf = (url: string) => {
  const parsed = new URL(url)
  return parsed.searchParams.get('alt') === 'media'
    ? (parsed.pathname.split('/').at(-1) ?? null)
    : null
}

const epoch = new Date(0)

function fakeJob(queue: string, data: object): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: queue,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 0,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: epoch,
    startedOn: epoch,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 604800,
    createdOn: epoch,
    completedOn: null,
    keepUntil: epoch,
    policy: 'standard',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: '',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  }
}

const silentHost = (): JobHost => {
  const noop = async (_q: string, _id: string, _o: JobOutcome) => undefined
  return {
    complete: noop,
    fail: noop,
    failTerminal: noop,
    send: async () => undefined,
  }
}

type Sent = { readonly queue: string; readonly data: Record<string, unknown> }

/** The fake API wired as the installed Drive, with a recording `Enqueue`. */
const wiredDrive = async (
  options: { readonly atSend?: () => Promise<void> } = {},
) => {
  const api = makeFakeDriveApi({
    seed: [...FAKE_DRIVE_SEED, ...FAKE_DRIVE_RESEARCH_SEED],
  })
  const onDownload = new Map<string, () => Promise<void>>()
  const fetch: FetchLike = async (url, init) => {
    const id = downloadOf(url)
    const hook = id === null ? undefined : onDownload.get(id)
    if (id !== null && hook !== undefined) {
      onDownload.delete(id)
      await hook()
    }
    return api.fetch(url, init)
  }
  const root = pluginsRootWith('storage-loose-ends', ['google-drive'])
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
            fetch,
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
        Effect.promise(async () => {
          await options.atSend?.()
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
  const bindJob = (data: BindStorageFolderData) =>
    Effect.runPromiseExit(
      bindStorageFolder
        .run(data)
        .pipe(
          Effect.provide(layer),
          Effect.provideService(JobContext, context(QUEUES.bindStorageFolder)),
        ),
    )
  /** One attempt through `runJob`, which writes its `job_run` row. */
  const ledgered = {
    sync: (data: object) =>
      runJob(syncStorageBinding, { host: silentHost(), layer })([
        fakeJob(QUEUES.syncStorageBinding, data),
      ]),
    export: (data: object) =>
      runJob(exportDocument, { host: silentHost(), layer })([
        fakeJob(QUEUES.exportDocument, data),
      ]),
  }
  return { api, sent, onDownload, poll, sync, bindJob, ledgered }
}

const bind = async (input: {
  connectionId: string
  folderId: string
  ancestorIds: ReadonlyArray<string>
  path: string
  target: string
  mapSubfolders?: boolean
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
          sensitivity: 'inherit',
        },
      }),
    )
  ).id

const ROOM = {
  folderId: 'dataroom',
  ancestorIds: ['root'],
  path: 'My Drive / Acme Data Room',
}

const HYDROGEN = {
  folderId: 'hydrogen',
  ancestorIds: ['root', 'research'],
  path: 'My Drive / Research / Hydrogen',
}

const OPTIONS = {
  mapSubfolders: false,
  retain: 'full',
  direction: 'pull',
  sensitivity: 'inherit',
} as const

const aFile = (id: string, parentId: string): FakeDriveSeedItem => ({
  kind: 'file',
  id,
  name: `${id}.pdf`,
  parentId,
  mime: 'application/pdf',
  content: `%PDF-1.7 ${id}`,
})

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const reasonOf = (exit: Exit.Exit<JobResult, JobFailure>): string => {
  if (Exit.isSuccess(exit)) throw new Error('the job succeeded')
  const found = Cause.findErrorOption(exit.cause)
  if (found._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  return found.value.reason
}

/** Every binding past the poll's minimum interval. */
const age = () =>
  db
    .update(storageBinding)
    .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
    .where(isNotNull(storageBinding.id))

const byExternalId = (externalId: string, connectionId: string) =>
  db
    .select({ id: document.entityId, bindingId: document.bindingId })
    .from(document)
    .where(
      and(
        eq(document.externalId, externalId),
        eq(document.connectionId, connectionId),
      ),
    )

const statusOf = async (bindingId: string) =>
  (
    await db
      .select({ status: storageBinding.status, error: storageBinding.error })
      .from(storageBinding)
      .where(eq(storageBinding.id, bindingId))
  ).at(0)

/** One company per name for the whole file: a folder maps by exact name. */
const company = async (name: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      source: { class: 'manual' },
    })
  ).entityId

const MERGED = (name: string) =>
  `“${name}” was merged into another record — file the document against that one.`

describe('a starting cursor at bind', () => {
  it('binding on a connection with no cursor stores one before the first sync is sent; a file added during the first walk is filed by the next poll', async () => {
    const connectionId = await aConnection()
    const cursorAtSend: Array<string | null> = []
    const drive = await wiredDrive({
      atSend: async () => {
        cursorAtSend.push(await cursorOf(connectionId))
      },
    })
    const deal = await aRecord('deal', 'Acme Cursor')
    expect(await cursorOf(connectionId)).toBeNull()

    succeeded(
      await drive.bindJob({
        connectionId,
        folder: { id: 'dataroom' },
        targetEntityId: deal,
        actorUserId: FIXTURE_ACTOR.id,
        options: OPTIONS,
      }),
    )
    expect(drive.sent.map((s) => s.queue)).toEqual([QUEUES.syncStorageBinding])
    const started = cursorAtSend.at(0) ?? null
    expect(started).not.toBeNull()
    const bindingId = String(drive.sent.at(0)?.data.bindingId)

    succeeded(await drive.sync(bindingId))
    // Added once the walk had passed the data room: only the poll sees it.
    drive.api.drive.add(aFile('late', 'dataroom'))
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/: 1 new, /)
    expect(await byExternalId('late', connectionId)).toEqual([
      { id: expect.any(String), bindingId },
    ])

    // A connection that has a cursor keeps it through the next bind.
    const kept = await cursorOf(connectionId)
    succeeded(
      await drive.bindJob({
        connectionId,
        folder: { id: 'hydrogen' },
        targetEntityId: await aRecord('company', 'Hydrogen Cursor'),
        actorUserId: FIXTURE_ACTOR.id,
        options: OPTIONS,
      }),
    )
    expect(await cursorOf(connectionId)).toBe(kept)
  })
})

describe('run refs', () => {
  it('storage.sync and storage.export runs land on the bound record; a gone binding or document still completes', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme Refs')
    const bindingId = await bind({ connectionId, ...ROOM, target: deal })

    await drive.ledgered.sync({ bindingId })
    const deck = (await byExternalId('deck', connectionId)).at(0)
    if (deck === undefined) throw new Error('the sync filed no deck')
    await drive.ledgered.export({ documentId: deck.id })
    await drive.ledgered.sync({ bindingId: randomUUID() })
    await drive.ledgered.export({ documentId: randomUUID() })

    const rows = await db
      .select({
        queue: jobRun.queue,
        entityId: jobRun.entityId,
        status: jobRun.status,
        summary: jobRun.summary,
      })
      .from(jobRun)
      .where(
        inArray(jobRun.queue, [
          QUEUES.syncStorageBinding,
          QUEUES.exportDocument,
        ]),
      )
      .orderBy(asc(jobRun.startedAt))
    expect(rows).toEqual([
      {
        queue: QUEUES.syncStorageBinding,
        entityId: deal,
        status: 'succeeded',
        summary: expect.stringMatching(/^synced /),
      },
      {
        queue: QUEUES.exportDocument,
        entityId: deal,
        status: 'succeeded',
        summary: 'not an upload; nothing exported',
      },
      {
        queue: QUEUES.syncStorageBinding,
        entityId: null,
        status: 'succeeded',
        summary: 'the binding is gone; nothing synced',
      },
      {
        queue: QUEUES.exportDocument,
        entityId: null,
        status: 'succeeded',
        summary: 'the document or its binding is gone; nothing exported',
      },
    ])
  })
})

describe('a file the record refuses', () => {
  it('the walk skips it with its reason and files the rest; the binding stays active', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const ohmium = await company('Ohmium')
    const bindingId = await bind({
      connectionId,
      ...HYDROGEN,
      target: await aSpace('Hydrogen walk'),
      mapSubfolders: true,
    })
    // Ohmium's folder is placed, then the company is merged before its file is born.
    drive.onDownload.set('ohmium-overview', () => merge(ohmium))

    const said = String(succeeded(await drive.sync(bindingId)))
    expect(said).toContain(`Ohmium overview.pdf: ${MERGED('Ohmium')}`)
    expect(await byExternalId('ohmium-overview', connectionId)).toEqual([])
    expect(await byExternalId('h2-map', connectionId)).toHaveLength(1)
    expect(await byExternalId('ohium-intro', connectionId)).toHaveLength(1)
    expect(await statusOf(bindingId)).toEqual({ status: 'active', error: null })
  })

  it('the walk marks the binding error only when the bound record is gone', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const deal = await aRecord('deal', 'Acme Gone')
    const bindingId = await bind({ connectionId, ...ROOM, target: deal })
    drive.onDownload.set('deck', () => merge(deal))

    expect(reasonOf(await drive.sync(bindingId))).toBe(RECORD_GONE)
    expect(await statusOf(bindingId)).toEqual({
      status: 'error',
      error: RECORD_GONE,
    })
  })

  it('the poll skips it too, and refuses the binding only when the bound record is gone', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const ohium = await company('Ohium')
    const spaceId = await aSpace('Hydrogen poll')
    const bindingId = await bind({
      connectionId,
      ...HYDROGEN,
      target: spaceId,
      mapSubfolders: true,
    })
    succeeded(await drive.poll())
    succeeded(await drive.sync(bindingId))

    drive.api.drive.add(aFile('late-ohium', 'ohium'))
    drive.api.drive.add(aFile('late-h2', 'hydrogen'))
    drive.onDownload.set('late-ohium', () => merge(ohium))
    await age()
    const first = String(succeeded(await drive.poll()))
    expect(first).toContain(`1 new, `)
    expect(first).toContain(`1 skipped (late-ohium.pdf: ${MERGED('Ohium')})`)
    expect(first).not.toContain('refused')
    expect(await byExternalId('late-h2', connectionId)).toHaveLength(1)
    expect(await statusOf(bindingId)).toEqual({ status: 'active', error: null })

    drive.api.drive.add(aFile('later-h2', 'hydrogen'))
    drive.onDownload.set('later-h2', () => merge(spaceId))
    await age()
    expect(String(succeeded(await drive.poll()))).toContain(
      `1 bindings refused (${RECORD_GONE})`,
    )
    expect(await statusOf(bindingId)).toEqual({
      status: 'error',
      error: RECORD_GONE,
    })
  })
})
