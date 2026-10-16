import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  chunk,
  document,
  entity,
  workspace,
} from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import {
  addEdges,
  birthDocumentProgram,
} from '@spaces/core/writes/documents/birth'
import {
  raiseSensitivity,
  restampStampedProgram,
  stampSensitivity,
} from '@spaces/core/writes/ai/stamp-sensitivity'
import { enqueued } from '#/test/queue-stub'
import { webEnqueue } from '#/lib/enqueue-live'
import {
  fileDocumentProgram,
  unfileDocumentProgram,
} from '#/lib/documents/refile'
import { unlinkFolderProgram } from '#/lib/documents/bindings'
import { createSpaceRow } from '#/lib/server/shared'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { setSensitivityDefaultProgram } from './route'
import { sensitivityFor, setEntitySensitiveProgram } from './sensitivity-for'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * `chunk.sensitive` follows the binding and workspace inputs as it follows
 * flags and filings: raised in the transaction that writes the input,
 * lowered by `sensitivity.restamp`. The agreement test holds the cache to
 * the live resolver over a mixed fixture.
 */

let n = 0
const tag = () => `${String(++n)}_${Math.random().toString(36).slice(2, 6)}`

type Born = { bindingId?: string }

async function aDoc(name: string, born: Born = {}): Promise<string> {
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: null,
      filename: `${name}.html`,
      url: `https://example.com/${name}-${tag()}`,
      mime: 'text/html',
      sizeBytes: null,
      kind: 'other',
      sourceClass: 'manual',
      sourceRef: null,
      provenance:
        born.bindingId === undefined ? {} : { bindingId: born.bindingId },
      fileAgainst: [],
      actor: { userId: FIXTURE_ACTOR.id },
    }).pipe(Effect.provide(webEnqueue)),
  )
  return id
}

/** Chunks as the embed job writes them: the default, then the stamp. */
async function embed(entityId: string, name: string): Promise<void> {
  await db.insert(chunk).values(
    [0, 1, 2].map((idx): typeof chunk.$inferInsert => ({
      entityId,
      sourceKind: 'document',
      sourceKey: '',
      idx,
      text: `${name} page ${String(idx)}`,
    })),
  )
  await Effect.runPromise(stampSensitivity(entityId))
}

async function anEmbeddedDoc(name: string, born: Born = {}) {
  const id = await aDoc(name, born)
  await embed(id, name)
  return id
}

async function aCompany(name: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `${name} ${tag()}` })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
}

async function aConnection(): Promise<string> {
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
          { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' },
          { userId, provider: 'google' },
        ),
        scopes: ['openid', 'email', 'drive.file', 'drive.readonly'],
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!row) throw new Error('no connection')
  return row.id
}

async function aBinding(
  target: string,
  sensitivity: 'inherit' | 'sensitive',
): Promise<{ id: string; path: string }> {
  const folderId = `folder-${tag()}`
  const path = `My Drive / ${folderId} / Data room`
  const { id } = await Effect.runPromise(
    bindFolderProgram({
      connectionId: await aConnection(),
      provider: 'google',
      folder: { folderId, ancestorIds: ['root'], path },
      targetEntityId: target,
      boundBy: FIXTURE_ACTOR.id,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity,
      },
    }),
  )
  return { id, path }
}

const aSpace = (name: string, parentId: string | null = null) =>
  createSpaceRow(`${name} ${tag()}`, parentId, FIXTURE_ACTOR.id)

async function stamps(entityId: string): Promise<Array<boolean>> {
  const rows = await db
    .select({ sensitive: chunk.sensitive })
    .from(chunk)
    .where(eq(chunk.entityId, entityId))
  expect(rows.length).toBeGreaterThan(0)
  return [...new Set(rows.map((r) => r.sensitive))]
}

const flag = (entityId: string, sensitive = true) =>
  Effect.runPromise(setEntitySensitiveProgram(entityId, sensitive))

const fileIn = (documentId: string, spaceId: string) =>
  Effect.runPromise(
    fileDocumentProgram(FIXTURE_ACTOR.id, {
      documentId,
      target: { kind: 'space', entityId: spaceId },
    }),
  )

const unfileFrom = (documentId: string, spaceId: string) =>
  Effect.runPromise(
    unfileDocumentProgram(FIXTURE_ACTOR.id, {
      documentId,
      target: { kind: 'space', entityId: spaceId },
    }),
  )

const setDefault = (sensitivity: 'normal' | 'sensitive') =>
  Effect.runPromise(setSensitivityDefaultProgram({ sensitivity }))

const restamps = () =>
  enqueued.filter((e) => e.name === QUEUES.restampSensitivity)

/** Run every queued restamp, as the worker would, and forget them. */
async function runRestamps(): Promise<void> {
  for (const job of restamps()) {
    const id = job.data.entityId
    if (typeof id === 'string') await Effect.runPromise(stampSensitivity(id))
    else if (job.data.all === true)
      await Effect.runPromise(restampStampedProgram())
  }
  enqueued.length = 0
}

beforeEach(async () => {
  enqueued.length = 0
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings: {} })
    .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
})

describe('a storage binding', () => {
  it('a document born under a sensitive binding resolves sensitive, and the embed stamps it', async () => {
    const target = await aCompany('Ohmium')
    const sensitive = await aBinding(target, 'sensitive')
    const inherit = await aBinding(target, 'inherit')

    const room = await anEmbeddedDoc('cap-table', { bindingId: sensitive.id })
    const shared = await anEmbeddedDoc('teaser', { bindingId: inherit.id })

    expect(await stamps(room)).toEqual([true])
    expect(await stamps(shared)).toEqual([false])
    expect(await Effect.runPromise(sensitivityFor(room))).toEqual({
      own: false,
      sensitivity: 'sensitive',
      via: { kind: 'binding', name: sensitive.path },
    })
    expect((await Effect.runPromise(sensitivityFor(target))).sensitivity).toBe(
      'normal',
    )
  })

  it('a held document claimed for a sensitive binding is raised in the claim, no job run', async () => {
    const target = await aCompany('Ohmium')
    const binding = await aBinding(target, 'sensitive')
    const held = await anEmbeddedDoc('model')
    expect(await stamps(held)).toEqual([false])

    // The sync's claim: the binding set, then the edges, in one transaction.
    await db.transaction(async (tx) => {
      await tx
        .update(document)
        .set({ bindingId: binding.id })
        .where(eq(document.entityId, held))
      await addEdges(
        tx,
        held,
        [{ kind: 'record', entityId: target }],
        FIXTURE_ACTOR.id,
      )
    })
    expect(await stamps(held)).toEqual([true])
    expect(restamps()).toEqual([])
  })

  it('the binding raise reaches every document the binding brought, and only when it is sensitive', async () => {
    const target = await aCompany('Ohmium')
    const sensitive = await aBinding(target, 'sensitive')
    const inherit = await aBinding(target, 'inherit')
    const a = await anEmbeddedDoc('a', { bindingId: sensitive.id })
    const b = await anEmbeddedDoc('b', { bindingId: inherit.id })
    // Stale rows, as if a stamp had lagged the binding.
    await db
      .update(chunk)
      .set({ sensitive: false })
      .where(inArray(chunk.entityId, [a, b]))

    const raised = await db.transaction(async (tx) => ({
      sensitive: await raiseSensitivity(tx, {
        kind: 'binding',
        bindingId: sensitive.id,
      }),
      inherit: await raiseSensitivity(tx, {
        kind: 'binding',
        bindingId: inherit.id,
      }),
    }))
    expect(raised).toEqual({ sensitive: 3, inherit: 0 })
    expect(await stamps(a)).toEqual([true])
    expect(await stamps(b)).toEqual([false])
  })

  it('unlinking a sensitive binding restamps what it brought; a document held by a space stays', async () => {
    const target = await aCompany('Ohmium')
    const binding = await aBinding(target, 'sensitive')
    const space = await aSpace('Hydrogen')
    await flag(space)
    const loose = await anEmbeddedDoc('loose', { bindingId: binding.id })
    const kept = await anEmbeddedDoc('kept', { bindingId: binding.id })
    await fileIn(kept, space)
    enqueued.length = 0

    expect(await Effect.runPromise(unlinkFolderProgram(binding.id))).toBe(true)
    expect(
      restamps()
        .map((e) => e.data.entityId)
        .sort(),
    ).toEqual([loose, kept].sort())
    await runRestamps()
    expect(await stamps(loose)).toEqual([false])
    expect(await stamps(kept)).toEqual([true])
  })
})

describe('the workspace default', () => {
  it('flipping to sensitive stamps every chunk in the same call; back to normal is one job over everything', async () => {
    const flagged = await anEmbeddedDoc('flagged')
    await flag(flagged)
    const a = await anEmbeddedDoc('a')
    const b = await anEmbeddedDoc('b')
    expect(await stamps(a)).toEqual([false])

    await setDefault('sensitive')
    for (const id of [flagged, a, b]) expect(await stamps(id)).toEqual([true])
    expect(restamps()).toEqual([])

    await setDefault('normal')
    expect(restamps()).toEqual([
      {
        name: QUEUES.restampSensitivity,
        data: { all: true },
        options: { singletonKey: 'all' },
      },
    ])
    await runRestamps()
    expect(await stamps(a)).toEqual([false])
    expect(await stamps(b)).toEqual([false])
    expect(await stamps(flagged)).toEqual([true])
  })

  it('normal to normal sends nothing', async () => {
    await anEmbeddedDoc('a')
    await setDefault('normal')
    expect(restamps()).toEqual([])
  })

  it('a chunk embedded under a sensitive default is stamped by the embed', async () => {
    await setDefault('sensitive')
    const late = await anEmbeddedDoc('late')
    expect(await stamps(late)).toEqual([true])
  })
})

describe('lowering keeps what another input holds', () => {
  it('unflagging a space lowers a document filed nowhere else, and keeps one also under a second sensitive space', async () => {
    const hydrogen = await aSpace('Hydrogen')
    const defence = await aSpace('Defence')
    await flag(hydrogen)
    await flag(defence)
    const only = await anEmbeddedDoc('only')
    const both = await anEmbeddedDoc('both')
    await fileIn(only, hydrogen)
    await fileIn(both, hydrogen)
    await fileIn(both, defence)
    expect(await stamps(only)).toEqual([true])
    expect(await stamps(both)).toEqual([true])

    await flag(hydrogen, false)
    await runRestamps()
    expect(await stamps(only)).toEqual([false])
    expect(await stamps(both)).toEqual([true])
  })
})

describe('agreement', () => {
  it('after the raises and the lowerings, every chunk’s stamp is what the resolver says of its owner', async () => {
    const root = await aSpace('Energy')
    const mid = await aSpace('Hydrogen', root)
    const leaf = await aSpace('Electrolysers', mid)
    const other = await aSpace('Defence')
    const target = await aCompany('Ohmium')
    const sensitiveRoom = await aBinding(target, 'sensitive')
    const plainRoom = await aBinding(target, 'inherit')

    const inLeaf = await anEmbeddedDoc('in-leaf')
    const inLeafAndOther = await anEmbeddedDoc('in-leaf-and-other')
    const flaggedOwn = await anEmbeddedDoc('flagged-own')
    const roomDoc = await anEmbeddedDoc('room', {
      bindingId: sensitiveRoom.id,
    })
    const plainRoomDoc = await anEmbeddedDoc('plain-room', {
      bindingId: plainRoom.id,
    })
    const loose = await anEmbeddedDoc('loose')
    const unfiled = await anEmbeddedDoc('unfiled-later')
    await fileIn(inLeaf, leaf)
    await fileIn(inLeafAndOther, leaf)
    await fileIn(inLeafAndOther, other)
    await fileIn(plainRoomDoc, mid)
    await fileIn(unfiled, other)

    // Raises, each in its own write.
    await flag(root)
    await flag(other)
    await flag(flaggedOwn)
    await setDefault('sensitive')
    // Lowerings, each a job.
    await setDefault('normal')
    await flag(root, false)
    await unfileFrom(unfiled, other)
    await flag(mid)
    await runRestamps()

    const owners = [
      inLeaf,
      inLeafAndOther,
      flaggedOwn,
      roomDoc,
      plainRoomDoc,
      loose,
      unfiled,
    ]
    const want = new Map<string, boolean>()
    for (const id of owners)
      want.set(
        id,
        (await Effect.runPromise(sensitivityFor(id))).sensitivity ===
          'sensitive',
      )
    // Every input is in play: some sensitive, some not.
    expect(new Set(want.values())).toEqual(new Set([true, false]))
    expect(want.get(loose)).toBe(false)
    expect(want.get(roomDoc)).toBe(true)

    const rows = await db
      .select({ entityId: chunk.entityId, sensitive: chunk.sensitive })
      .from(chunk)
      .where(inArray(chunk.entityId, owners))
    expect(rows.length).toBe(owners.length * 3)
    for (const row of rows)
      expect(row.sensitive, row.entityId).toBe(want.get(row.entityId))
  })
})
