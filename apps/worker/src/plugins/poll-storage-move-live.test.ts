import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  documentRevision,
  entity,
  entitySpace,
  integration,
  link,
  space,
  storageBinding,
  suggestion,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  FAKE_DRIVE_RESEARCH_SEED,
  FAKE_DRIVE_SEED,
  makeFakeDriveApi,
} from '@spaces/sdk/testing'
import type { FakeDriveApi, FakeDriveSeedItem } from '@spaces/sdk/testing'
import {
  acceptProgram,
  rejectProgram,
  suggestionMessage,
} from '#web/lib/ai/propose'
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
 * The change poll's renamed / moved row (§8) end to end on the real
 * google-drive bundle against the mutable fake Drive: a rename or a move
 * inside the bound subtree advances the path in place, and a move that
 * crosses to another record's folder is a re-file suggestion a person
 * accepts, never a silent re-file (§5.6). A move under another binding of
 * the same connection is the same rule, and the file's binding follows.
 * - Its own file: each case seeds companies by name, and two cases' names
 *   in one database would no longer match exactly.
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
  // A case's copies stay, unfiled: the same seed bytes on the same company
  // would otherwise attach to the last case's document.
  await db.delete(link).where(eq(link.relation, 'tagged_in'))
  await db.delete(entitySpace).where(isNotNull(entitySpace.entityId))
  await db.delete(suggestion).where(isNotNull(suggestion.id))
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
  const root = pluginsRootWith('poll-storage-move', ['google-drive'])
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
  return { api, sent, poll, sync }
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

const revisionsOf = (documentId: string) =>
  db
    .select({ blobSha: documentRevision.blobSha })
    .from(documentRevision)
    .where(eq(documentRevision.documentId, documentId))

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
      externalStatus: document.externalStatus,
      blobSha: document.blobSha,
      externalRevisionId: document.externalRevisionId,
      kind: document.kind,
    })
    .from(document)
    .where(
      and(
        eq(document.externalId, externalId),
        eq(document.connectionId, connectionId),
      ),
    )

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

let spaces = 0

/**
 * One company per name for the whole file: a name-only resolve creates, and
 * two exact matches would leave a folder unmapped.
 */
const companies = new Map<string, string>()
const company = async (name: string) => {
  const held = companies.get(name)
  if (held !== undefined) return held
  const { entityId } = await resolveEntity({
    kind: 'company',
    name,
    source: { class: 'manual' },
  })
  companies.set(name, entityId)
  return entityId
}

/** A space bound to `Research / Hydrogen` with map_subfolders on, its companies held. */
const mappedResearch = async (extra: ReadonlyArray<FakeDriveSeedItem> = []) => {
  const drive = await wiredDrive([
    ...FAKE_DRIVE_SEED,
    ...FAKE_DRIVE_RESEARCH_SEED,
    ...extra,
  ])
  const connectionId = await aConnection()
  const spaceId = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: 'Hydrogen' })
      .returning({ id: entity.id })
  ).at(0)?.id
  if (spaceId === undefined) throw new Error('no space')
  spaces += 1
  await db.insert(space).values({
    entityId: spaceId,
    slug: `move-h2-${String(spaces)}`,
    path: `move_h2_${String(spaces)}`,
  })
  const ohmium = await company('Ohmium')
  const ohium = await company('Ohium')
  const bindingId = await bind({
    connectionId,
    folderId: 'hydrogen',
    ancestorIds: ['root', 'research'],
    path: 'My Drive / Research / Hydrogen',
    target: spaceId,
    mapSubfolders: true,
  })
  succeeded(await drive.poll())
  succeeded(await drive.sync(bindingId))
  return { drive, connectionId, spaceId, ohmium, ohium }
}

const H2 = 'My Drive / Research / Hydrogen'

/** Every filing edge a document has: `tagged_in` links and space rows, sorted. */
const edges = async () =>
  [
    ...(
      await db
        .select({ from: link.fromEntityId, to: link.toEntityId })
        .from(link)
        .where(eq(link.relation, 'tagged_in'))
    ).map((e) => `${e.from} tagged_in ${e.to}`),
    ...(
      await db
        .select({ from: entitySpace.entityId, to: entitySpace.spaceId })
        .from(entitySpace)
    ).map((e) => `${e.from} in ${e.to}`),
  ].sort()

const refiles = () =>
  db
    .select({
      entityId: suggestion.entityId,
      status: suggestion.status,
      payload: suggestion.payload,
      proposedByType: suggestion.proposedByType,
    })
    .from(suggestion)
    .where(eq(suggestion.kind, 'refile_document'))

/** The one open re-file's id. */
const openRefileId = async () => {
  const open = await db
    .select({ id: suggestion.id })
    .from(suggestion)
    .where(
      and(
        eq(suggestion.kind, 'refile_document'),
        eq(suggestion.status, 'open'),
      ),
    )
  expect(open).toHaveLength(1)
  return open.at(0)?.id ?? ''
}

const extractionsOf = (sent: ReadonlyArray<Sent>, documentId: string) =>
  sent.filter(
    (s) =>
      s.queue === QUEUES.extractDocument && s.data.documentId === documentId,
  ).length

describe('storage.poll: renamed / moved inside the subtree (§8)', () => {
  it('§8 renamed inside the subtree: the name advances in place, no edge, no document, no extraction', async () => {
    const { drive, connectionId } = await mappedResearch()
    const before = (await byExternalId('h2-map', connectionId)).at(0)
    if (before === undefined) throw new Error('the walk filed no map')
    const snapshot = await edges()
    const count = await documentCount()
    const extracted = extractionsOf(drive.sent, before.id)

    drive.api.drive.rename('h2-map', 'Hydrogen market map 2026.pdf')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /: 0 new, 0 held, 0 attached by sha, 1 ignored, 0 outside, 0 revised, 1 moved$/,
    )

    const after = await db
      .select({
        filename: document.filename,
        sourcePath: document.sourcePath,
        blobSha: document.blobSha,
        name: entity.canonicalName,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(eq(document.entityId, before.id))
    expect(after).toEqual([
      {
        filename: 'Hydrogen market map 2026.pdf',
        sourcePath: H2,
        blobSha: before.blobSha,
        name: 'Hydrogen market map 2026.pdf',
      },
    ])
    expect(await edges()).toEqual(snapshot)
    expect(await documentCount()).toBe(count)
    expect(extractionsOf(drive.sent, before.id)).toBe(extracted)
    expect(await revisionsOf(before.id)).toEqual([])
    expect(await refiles()).toEqual([])
  })

  it('§8 renamed inside the subtree: a native Doc’s rename is no revision and reads no export', async () => {
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const room = await bind({
      connectionId,
      ...ROOM,
      target: await aRecord('deal', 'Acme'),
    })
    succeeded(await drive.poll())
    succeeded(await drive.sync(room))
    const memo = (await byExternalId('memo', connectionId)).at(0)
    if (memo === undefined) throw new Error('the walk filed no memo')
    const exports = drive.api.exports()

    drive.api.drive.rename('memo', 'Investment memo v2')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /, 0 revised, 1 moved$/,
    )
    expect(drive.api.exports()).toBe(exports)
    const after = await db
      .select({
        filename: document.filename,
        blobSha: document.blobSha,
        token: document.externalRevisionId,
      })
      .from(document)
      .where(eq(document.entityId, memo.id))
    expect(after).toEqual([
      {
        filename: 'Investment memo v2.docx',
        blobSha: memo.blobSha,
        token: drive.api.drive.entry('memo')?.changeToken,
      },
    ])
    expect(await revisionsOf(memo.id)).toEqual([])
    expect(extractionsOf(drive.sent, memo.id)).toBe(1)
  })

  it('§8 moved inside the subtree: source_path advances, the filing stands', async () => {
    const { drive, connectionId, spaceId } = await mappedResearch()
    const map = (await byExternalId('h2-map', connectionId)).at(0)
    if (map === undefined) throw new Error('the walk filed no map')
    const snapshot = await edges()

    drive.api.drive.move('h2-map', 'electrolysers')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/, 1 moved$/)

    // The move bumped the token; the bytes are the same, so only it is kept.
    expect((await byExternalId('h2-map', connectionId)).at(0)).toEqual({
      ...map,
      sourcePath: `${H2} / Electrolysers`,
      externalRevisionId: drive.api.drive.entry('h2-map')?.changeToken,
    })
    expect(await revisionsOf(map.id)).toEqual([])
    expect(await edges()).toEqual(snapshot)
    expect(snapshot).toContain(`${map.id} in ${spaceId}`)
    expect(await refiles()).toEqual([])
  })

  it('§8 moved across a company folder: deck.pdf from Ohmium to Ohium is one suggestion naming both, and no edge moves', async () => {
    const { drive, connectionId, ohmium, ohium } = await mappedResearch([
      { ...aFile('deck-pdf', 'ohmium'), name: 'deck.pdf' },
    ])
    const deck = (await byExternalId('deck-pdf', connectionId)).at(0)
    if (deck === undefined) throw new Error('the walk filed no deck')
    expect(await taggedIn(deck.id)).toEqual([ohmium])
    const snapshot = await edges()
    const count = await documentCount()
    const extracted = extractionsOf(drive.sent, deck.id)

    drive.api.drive.move('deck-pdf', 'ohium')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /, 0 revised, 1 moved to re-file$/,
    )

    expect(
      (await byExternalId('deck-pdf', connectionId)).at(0)?.sourcePath,
    ).toBe(`${H2} / Ohium`)
    expect(await edges()).toEqual(snapshot)
    expect(await documentCount()).toBe(count)
    expect(extractionsOf(drive.sent, deck.id)).toBe(extracted)
    expect(await refiles()).toEqual([
      {
        entityId: deck.id,
        status: 'open',
        proposedByType: 'integration',
        payload: {
          documentId: deck.id,
          fromEntityId: ohmium,
          toEntityId: ohium,
          sourcePath: `${H2} / Ohium`,
          documentName: 'deck.pdf',
          fromName: 'Ohmium',
          toName: 'Ohium',
        },
      },
    ])

    // The same file seen again proposes nothing more.
    drive.api.drive.nudge('deck-pdf')
    await age()
    succeeded(await drive.poll())
    expect(await refiles()).toHaveLength(1)

    // Accepted, the edge moves, by the accepter.
    const id = await openRefileId()
    const accepted = await Effect.runPromise(
      acceptProgram(id, { type: 'user', id: FIXTURE_ACTOR.id }),
    )
    expect(accepted).toMatchObject({
      kind: 'refile_document',
      documentId: deck.id,
      fromEntityId: ohmium,
      toEntityId: ohium,
    })
    expect(await taggedIn(deck.id)).toEqual([ohium])
    const by = await db
      .select({ createdBy: link.createdBy })
      .from(link)
      .where(and(eq(link.fromEntityId, deck.id), eq(link.toEntityId, ohium)))
    expect(by).toEqual([{ createdBy: FIXTURE_ACTOR.id }])
    expect((await refiles()).map((r) => r.status)).toEqual(['accepted'])
  })

  it('a re-file rejected leaves the filing, and an accept after the document left its record refuses and stays open', async () => {
    const { drive, connectionId, ohmium } = await mappedResearch()
    const overview = (await byExternalId('ohmium-overview', connectionId)).at(0)
    if (overview === undefined) throw new Error('the walk filed no overview')
    drive.api.drive.move('ohmium-overview', 'ohium')
    await age()
    succeeded(await drive.poll())
    const first = await openRefileId()
    await Effect.runPromise(
      rejectProgram(first, { type: 'user', id: FIXTURE_ACTOR.id }),
    )
    expect(await taggedIn(overview.id)).toEqual([ohmium])

    // Rejected is never proposed again for the same destination.
    drive.api.drive.move('ohmium-overview', 'ohmium')
    await age()
    succeeded(await drive.poll())
    drive.api.drive.move('ohmium-overview', 'ohium')
    await age()
    succeeded(await drive.poll())
    expect((await refiles()).map((r) => r.status)).toEqual(['rejected'])

    // A person moves it by hand before an open proposal is decided.
    const notes = (await byExternalId('ohmium-notes', connectionId)).at(0)
    if (notes === undefined) throw new Error('the walk filed no notes')
    drive.api.drive.move('ohmium-notes', 'ohium')
    await age()
    succeeded(await drive.poll())
    const stale = await openRefileId()
    await db
      .delete(link)
      .where(and(eq(link.fromEntityId, notes.id), eq(link.toEntityId, ohmium)))
    const refused = await Effect.runPromiseExit(
      acceptProgram(stale, { type: 'user', id: FIXTURE_ACTOR.id }),
    )
    if (Exit.isSuccess(refused)) throw new Error('a stale re-file was accepted')
    expect(suggestionMessage(Cause.squash(refused.cause))).toBe(
      'notes.txt is no longer filed on Ohmium',
    )
    expect(await taggedIn(notes.id)).toEqual([])
    const row = await db
      .select({ status: suggestion.status })
      .from(suggestion)
      .where(eq(suggestion.id, stale))
    expect(row).toEqual([{ status: 'open' }])
  })

  it('a reorganisation under one company moves paths only and proposes nothing', async () => {
    const { drive, connectionId, ohmium } = await mappedResearch()
    const snapshot = await edges()

    // Data room's files and the loose overview, all into Documents.
    for (const id of ['ohmium-notes', 'ohmium-model', 'ohmium-overview'])
      drive.api.drive.move(id, 'ohmium-documents')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(/, 3 moved$/)

    for (const id of ['ohmium-notes', 'ohmium-model', 'ohmium-overview']) {
      const doc = (await byExternalId(id, connectionId)).at(0)
      expect(doc?.sourcePath).toBe(`${H2} / Ohmium / Documents`)
      expect(await taggedIn(doc?.id ?? '')).toEqual([ohmium])
    }
    expect(await edges()).toEqual(snapshot)
    expect(await refiles()).toEqual([])
  })
})

describe('storage.poll: moved into another binding’s subtree (§8)', () => {
  /** The data room bound to `room`, Research to `research`, one connection, both synced. */
  const twoBindings = async (room: string, research: string) => {
    const drive = await wiredDrive([
      ...FAKE_DRIVE_SEED,
      ...FAKE_DRIVE_RESEARCH_SEED,
    ])
    const connectionId = await aConnection()
    const roomBinding = await bind({ connectionId, ...ROOM, target: room })
    const researchBinding = await bind({
      connectionId,
      folderId: 'research',
      ancestorIds: ['root'],
      path: 'My Drive / Research',
      target: research,
    })
    succeeded(await drive.poll())
    succeeded(await drive.sync(roomBinding))
    succeeded(await drive.sync(researchBinding))
    return { drive, connectionId, roomBinding, researchBinding }
  }

  it('§8 moved under another binding, same owner: source_path and binding_id advance, nothing proposed', async () => {
    const acme = await aRecord('company', 'Acme Two Folders')
    const { drive, connectionId, roomBinding, researchBinding } =
      await twoBindings(acme, acme)
    const deck = (await byExternalId('deck', connectionId)).at(0)
    if (deck === undefined) throw new Error('the walk filed no deck')
    expect(deck.bindingId).toBe(roomBinding)
    const snapshot = await edges()
    const count = await documentCount()

    drive.api.drive.move('deck', 'research')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /, 0 revised, 1 moved$/,
    )

    expect((await byExternalId('deck', connectionId)).at(0)).toEqual({
      ...deck,
      bindingId: researchBinding,
      sourcePath: 'My Drive / Research',
      externalRevisionId: drive.api.drive.entry('deck')?.changeToken,
    })
    expect(await taggedIn(deck.id)).toEqual([acme])
    expect(await edges()).toEqual(snapshot)
    expect(await documentCount()).toBe(count)
    expect(await refiles()).toEqual([])
  })

  it('§8 moved under another binding, owner changed: binding_id follows and a re-file names both records', async () => {
    const deal = await aRecord('deal', 'Acme Seed')
    const other = await aRecord('company', 'Research Holdings')
    const { drive, connectionId, researchBinding } = await twoBindings(
      deal,
      other,
    )
    const deck = (await byExternalId('deck', connectionId)).at(0)
    if (deck === undefined) throw new Error('the walk filed no deck')
    const snapshot = await edges()

    drive.api.drive.move('deck', 'research')
    await age()
    expect(String(succeeded(await drive.poll()))).toMatch(
      /, 0 revised, 1 moved to re-file$/,
    )

    const after = (await byExternalId('deck', connectionId)).at(0)
    expect(after?.bindingId).toBe(researchBinding)
    expect(after?.sourcePath).toBe('My Drive / Research')
    // Proposed, never re-filed: the edge stays on the deal.
    expect(await taggedIn(deck.id)).toEqual([deal])
    expect(await edges()).toEqual(snapshot)
    expect(await refiles()).toEqual([
      {
        entityId: deck.id,
        status: 'open',
        proposedByType: 'integration',
        payload: {
          documentId: deck.id,
          fromEntityId: deal,
          toEntityId: other,
          sourcePath: 'My Drive / Research',
          documentName: 'Acme deck.pdf',
          fromName: 'Acme Seed',
          toName: 'Research Holdings',
        },
      },
    ])
  })
})
