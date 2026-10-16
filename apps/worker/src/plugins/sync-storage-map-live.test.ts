import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
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
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  FAKE_DRIVE_RESEARCH_SEED,
  FAKE_DRIVE_SEED,
  makeFakeDriveApi,
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
import { syncStorageBinding } from '../jobs/sync-storage-binding'

/**
 * A bound folder's sync with `map_subfolders` on, end to end on the real
 * google-drive bundle against the fake Drive's research tree, with no AI
 * provider configured: folder names are hints, never identity.
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

let n = 0
const aSpace = async (name: string) => {
  n += 1
  const slug = `map${String(n)}`
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (ent === undefined) throw new Error('no space')
  await db.insert(space).values({ entityId: ent.id, slug, path: slug })
  return ent.id
}

/** Ohmium, held, with its Series B deal referencing it. */
const heldOhmium = async () => {
  const { entityId: company } = await resolveEntity({
    kind: 'company',
    name: 'Ohmium',
    source: { class: 'manual' },
  })
  const deal = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: 'Ohmium Series B' })
      .returning({ id: entity.id })
  ).at(0)
  if (deal === undefined) throw new Error('no deal')
  await db.insert(link).values({
    fromEntityId: deal.id,
    toEntityId: company,
    relation: 'references',
    attrSlug: 'company',
  })
  return { company, deal: deal.id }
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

/** The fake API with the research tree, wired as the installed Drive. */
const wiredDrive = async () => {
  const api = makeFakeDriveApi({
    seed: [...FAKE_DRIVE_SEED, ...FAKE_DRIVE_RESEARCH_SEED],
  })
  const root = pluginsRootWith('sync-storage-map', ['google-drive'])
  await db.insert(integration).values({
    capabilityId: 'google-drive',
    version: '0.1.0',
    enabled: true,
    config: { folderId: 'hydrogen' },
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
  return Layer.mergeAll(
    storageSourcesLayer(host, { fakes, pluginsRoot: root }),
    NoEnqueue,
    pluginBreakerLayer(host),
  )
}

/** A folder of the research tree bound to `target`, and its sync. */
const bound = async (input: {
  readonly folderId: string
  readonly ancestorIds: ReadonlyArray<string>
  readonly path: string
  readonly target: string
  readonly mapSubfolders: boolean
}) => {
  const layer = await wiredDrive()
  const { id: bindingId } = await Effect.runPromise(
    bindFolderProgram({
      connectionId: await aConnection(),
      provider: 'google',
      folder: {
        folderId: input.folderId,
        ancestorIds: [...input.ancestorIds],
        path: input.path,
      },
      targetEntityId: input.target,
      boundBy: FIXTURE_ACTOR.id,
      options: {
        mapSubfolders: input.mapSubfolders,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
    }),
  )
  const sync = () =>
    Effect.runPromiseExit(
      syncStorageBinding.run({ bindingId }).pipe(
        Effect.provide(layer),
        Effect.provideService(
          JobContext,
          JobContext.of({
            queue: QUEUES.syncStorageBinding,
            jobId: `test-${randomUUID()}`,
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
      ),
    )
  return { bindingId, sync }
}

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

/** Each synced file by Drive id: its kind and where it is filed. */
const filings = async (bindingId: string) => {
  const docs = await db
    .select({
      id: document.entityId,
      externalId: document.externalId,
      kind: document.kind,
    })
    .from(document)
    .where(eq(document.bindingId, bindingId))
  const out: Record<string, { kind: string; on: Array<string> }> = {}
  for (const d of docs) {
    const tagged = await db
      .select({ id: link.toEntityId })
      .from(link)
      .where(and(eq(link.fromEntityId, d.id), eq(link.relation, 'tagged_in')))
    const spaces = await db
      .select({ id: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, d.id))
    out[d.externalId ?? d.id] = {
      kind: d.kind,
      on: [...tagged, ...spaces].map((r) => r.id).sort(),
    }
  }
  return out
}

/** Every record that is not a document: what a folder must never create. */
const records = async () =>
  (
    await db
      .select({ id: entity.id })
      .from(entity)
      .where(ne(entity.kind, 'document'))
  ).length

const aiRuns = async () =>
  (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from ai_run`)
  ).rows.at(0)?.n

const HYDROGEN = {
  folderId: 'hydrogen',
  ancestorIds: ['root', 'research'],
  path: 'My Drive / Research / Hydrogen',
}

describe('storage.sync with map_subfolders on', () => {
  it('maps the seeded Research / Hydrogen tree bound to a space, creating no record', async () => {
    const hydrogen = await aSpace('Hydrogen')
    const { company, deal } = await heldOhmium()
    const room = await bound({
      ...HYDROGEN,
      target: hydrogen,
      mapSubfolders: true,
    })
    const recordsBefore = await records()

    expect(succeeded(await room.sync())).toBe(
      'synced 7 files, 7 new, 0 held, 0 attached by sha, ' +
        '1 unmapped (My Drive / Research / Hydrogen / Ohium ~ Ohmium)',
    )
    expect(await filings(room.bindingId)).toEqual({
      'h2-map': { kind: 'other', on: [hydrogen] },
      'ohmium-overview': { kind: 'other', on: [company] },
      'ohmium-notes': { kind: 'dd', on: [company] },
      'ohmium-model': { kind: 'dd', on: [company] },
      'ohmium-deck': { kind: 'deck', on: [company] },
      'ohmium-term-sheet': { kind: 'legal', on: [deal] },
      'ohium-intro': { kind: 'other', on: [hydrogen] },
    })
    // The typo, the empty folder and the kind folders made nothing.
    expect(await records()).toBe(recordsBefore)
    const ohium = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.canonicalName, 'Ohium'))
    expect(ohium).toEqual([])
    expect(await aiRuns()).toBe(0)

    // A re-run claims what it filed, where it filed it.
    expect(succeeded(await room.sync())).toBe(
      'synced 7 files, 0 new, 7 held, 0 attached by sha, ' +
        '1 unmapped (My Drive / Research / Hydrogen / Ohium ~ Ohmium)',
    )
    expect(Object.keys(await filings(room.bindingId))).toHaveLength(7)
    expect(await records()).toBe(recordsBefore)
  })

  it('with map_subfolders off files the same tree on the space, kinds by filename', async () => {
    const hydrogen = await aSpace('Hydrogen')
    await heldOhmium()
    const room = await bound({
      ...HYDROGEN,
      target: hydrogen,
      mapSubfolders: false,
    })

    expect(succeeded(await room.sync())).toBe(
      'synced 7 files, 7 new, 0 held, 0 attached by sha',
    )
    const filed = await filings(room.bindingId)
    expect(Object.values(filed).every((f) => f.on.join() === hydrogen)).toBe(
      true,
    )
    expect(filed['ohmium-notes'].kind).toBe('other')
    expect(filed['ohmium-deck'].kind).toBe('deck')
  })

  it('a company folder bound to a deal: kind from the folder, else the filename', async () => {
    const { deal } = await heldOhmium()
    const room = await bound({
      folderId: 'ohmium',
      ancestorIds: ['root', 'research', 'hydrogen'],
      path: 'My Drive / Research / Hydrogen / Ohmium',
      target: deal,
      mapSubfolders: true,
    })

    expect(succeeded(await room.sync())).toBe(
      'synced 5 files, 5 new, 0 held, 0 attached by sha',
    )
    expect(await filings(room.bindingId)).toEqual({
      'ohmium-overview': { kind: 'other', on: [deal] },
      'ohmium-notes': { kind: 'dd', on: [deal] },
      'ohmium-model': { kind: 'dd', on: [deal] },
      'ohmium-deck': { kind: 'deck', on: [deal] },
      'ohmium-term-sheet': { kind: 'legal', on: [deal] },
    })
  })
})
