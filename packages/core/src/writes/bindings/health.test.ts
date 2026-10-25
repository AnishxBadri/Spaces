import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  storageBinding,
  user,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { encryptBundle } from '../connections/bundle'
import { forgetConnection } from '../connections/list'
import { bindFolderProgram } from './bind'
import {
  accountBindingsProgram,
  failingBindingsProgram,
  providerSaid,
  rebindBindingProgram,
  waitingExportsByRecordProgram,
} from './health'

/**
 * Binding health against a real table: a re-bind moves the binding and its
 * documents onto the new connection in one transaction, Disconnect pauses
 * what was bound through it, and the account page and Today read them back.
 */

beforeEach(async () => {
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
})

async function aUser(name: string) {
  const id = `${name.toLowerCase()}-${randomUUID()}`
  await db
    .insert(user)
    .values({ id, name, email: `${id}@fund.example` })
    .onConflictDoNothing()
  return id
}

async function aRecord(name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no record')
  return row.id
}

async function aConnection(userId: string, cursor: string | null = null) {
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
        storageCursor: cursor,
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return row.id
}

async function bind(connectionId: string, folderId: string, target: string) {
  const bound = await Effect.runPromise(
    bindFolderProgram({
      connectionId,
      provider: 'google',
      folder: {
        folderId,
        ancestorIds: ['root'],
        path: `My Drive / ${folderId}`,
      },
      targetEntityId: target,
      boundBy: FIXTURE_ACTOR.id,
      options: {
        mapSubfolders: false,
        retain: 'full',
        direction: 'both',
        sensitivity: 'inherit',
      },
    }),
  )
  return bound.id
}

/** A document the binding filed, held through `connectionId`; with no external id, an upload waiting to export. */
async function aFiled(input: {
  bindingId: string | null
  connectionId: string | null
  externalId: string | null
}) {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: `${randomUUID()}.pdf` })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no document')
  await db.insert(document).values({
    entityId: row.id,
    blobSha: randomUUID().replaceAll('-', ''),
    bindingId: input.bindingId,
    connectionId: input.connectionId,
    externalId: input.externalId,
    externalStatus: input.externalId === null ? null : 'linked',
  })
  return row.id
}

const documentOf = async (id: string) =>
  (
    await db
      .select({
        connectionId: document.connectionId,
        bindingId: document.bindingId,
      })
      .from(document)
      .where(eq(document.entityId, id))
  ).at(0)

const bindingOf = async (id: string) =>
  (
    await db
      .select({
        connectionId: storageBinding.connectionId,
        status: storageBinding.status,
        error: storageBinding.error,
        lastSyncedAt: storageBinding.lastSyncedAt,
        boundBy: storageBinding.boundBy,
      })
      .from(storageBinding)
      .where(eq(storageBinding.id, id))
  ).at(0)

const markError = (id: string, error: string) =>
  db
    .update(storageBinding)
    .set({ status: 'error', error, lastSyncedAt: new Date() })
    .where(eq(storageBinding.id, id))

describe('providerSaid', () => {
  it('attributes the words to the provider by its label', () => {
    expect(providerSaid('google', 'File not found')).toBe(
      'Google said: File not found',
    )
  })
})

describe('rebindBindingProgram', () => {
  it('moves the binding and its documents onto the new connection, active and never synced', async () => {
    const priya = await aUser('Priya')
    const tomas = await aUser('Tomas')
    const old = await aConnection(priya)
    const fresh = await aConnection(tomas, 'tomas-cursor')
    const id = await bind(old, `room-${randomUUID()}`, await aRecord('Vayu'))
    const filed = await aFiled({
      bindingId: id,
      connectionId: old,
      externalId: 'file-1',
    })
    // Disconnect nulled this one's connection; it still belongs to the binding.
    const orphan = await aFiled({
      bindingId: id,
      connectionId: null,
      externalId: 'file-2',
    })
    // Tomas already holds file-3 himself: his copy is what the sync claims.
    const own = await aFiled({
      bindingId: null,
      connectionId: fresh,
      externalId: 'file-3',
    })
    const twin = await aFiled({
      bindingId: id,
      connectionId: old,
      externalId: 'file-3',
    })
    const upload = await aFiled({
      bindingId: id,
      connectionId: null,
      externalId: null,
    })
    await markError(id, 'Google said: Invalid Credentials')

    const outcome = await Effect.runPromise(
      rebindBindingProgram({
        bindingId: id,
        connectionId: fresh,
        actorUserId: tomas,
        startCursor: 'ignored',
      }),
    )
    expect(outcome).toEqual({
      _tag: 'rebound',
      repointed: 3,
      waiting: [upload],
    })
    expect(await bindingOf(id)).toEqual({
      connectionId: fresh,
      status: 'active',
      error: null,
      lastSyncedAt: null,
      boundBy: tomas,
    })
    expect((await documentOf(filed))?.connectionId).toBe(fresh)
    expect((await documentOf(orphan))?.connectionId).toBe(fresh)
    expect((await documentOf(twin))?.connectionId).toBe(old)
    expect((await documentOf(own))?.connectionId).toBe(fresh)
    // The new connection's own cursor is kept: a re-bind never resets it.
    const cursor = (
      await db
        .select({ cursor: accountConnection.storageCursor })
        .from(accountConnection)
        .where(eq(accountConnection.id, fresh))
    ).at(0)?.cursor
    expect(cursor).toBe('tomas-cursor')
  })

  it('stores a starting cursor on a connection that has none', async () => {
    const tomas = await aUser('Tomas')
    const old = await aConnection(await aUser('Priya'))
    const fresh = await aConnection(tomas)
    const id = await bind(old, `room-${randomUUID()}`, await aRecord('Vayu'))
    await markError(id, 'gone')
    await Effect.runPromise(
      rebindBindingProgram({
        bindingId: id,
        connectionId: fresh,
        actorUserId: tomas,
        startCursor: 'start-1',
      }),
    )
    const cursor = (
      await db
        .select({ cursor: accountConnection.storageCursor })
        .from(accountConnection)
        .where(eq(accountConnection.id, fresh))
    ).at(0)?.cursor
    expect(cursor).toBe('start-1')
  })

  it('refuses a binding that is syncing, and one that is gone, changing nothing', async () => {
    const tomas = await aUser('Tomas')
    const old = await aConnection(await aUser('Priya'))
    const fresh = await aConnection(tomas)
    const id = await bind(old, `room-${randomUUID()}`, await aRecord('Vayu'))
    const active = await Effect.runPromise(
      rebindBindingProgram({
        bindingId: id,
        connectionId: fresh,
        actorUserId: tomas,
      }),
    )
    expect(active._tag).toBe('refused')
    expect((await bindingOf(id))?.connectionId).toBe(old)
    const gone = await Effect.runPromise(
      rebindBindingProgram({
        bindingId: randomUUID(),
        connectionId: fresh,
        actorUserId: tomas,
      }),
    )
    expect(gone).toEqual({
      _tag: 'refused',
      reason: 'That folder is no longer linked',
    })
  })
})

describe('Disconnect and the bindings on it', () => {
  it('pauses every binding, naming who disconnected, and deletes no document', async () => {
    const priya = await aUser('Priya')
    const conn = await aConnection(priya)
    const a = await bind(conn, `room-${randomUUID()}`, await aRecord('Vayu'))
    const b = await bind(conn, `room-${randomUUID()}`, await aRecord('Ohmium'))
    const filed = await aFiled({
      bindingId: a,
      connectionId: conn,
      externalId: 'file-1',
    })

    expect(await forgetConnection(priya, conn)).toBe(true)
    const day = new Date().toISOString().slice(0, 10)
    for (const id of [a, b])
      expect(await bindingOf(id)).toMatchObject({
        connectionId: null,
        status: 'paused',
        error: `Priya disconnected ${day}`,
      })
    expect(await documentOf(filed)).toEqual({
      connectionId: null,
      bindingId: a,
    })
  })
})

describe('the account page and Today', () => {
  it('lists the account’s bindings first, then other paused or failing ones of the provider, never another’s healthy one', async () => {
    const mine = await aConnection(await aUser('Tomas'))
    const theirs = await aConnection(await aUser('Priya'))
    const own = await bind(mine, `room-${randomUUID()}`, await aRecord('Flent'))
    const healthy = await bind(
      theirs,
      `room-${randomUUID()}`,
      await aRecord('Acme'),
    )
    const failing = await bind(
      theirs,
      `room-${randomUUID()}`,
      await aRecord('Vayu'),
    )
    await markError(failing, 'Google said: File not found')
    await aFiled({ bindingId: own, connectionId: mine, externalId: 'f-1' })
    await aFiled({ bindingId: own, connectionId: mine, externalId: 'f-2' })

    const rows = await Effect.runPromise(
      accountBindingsProgram({ provider: 'google', connectionIds: [mine] }),
    )
    expect(rows.map((r) => r.id)).toEqual([own, failing])
    expect(rows.at(0)).toMatchObject({ targetName: 'Flent', files: 2 })
    expect(rows.map((r) => r.id)).not.toContain(healthy)

    const today = await Effect.runPromise(failingBindingsProgram())
    expect(today.map((r) => r.id)).toEqual([failing])
    expect(today.at(0)?.error).toBe('Google said: File not found')

    // Resolved: the line leaves.
    await db
      .update(storageBinding)
      .set({ status: 'active', error: null })
      .where(eq(storageBinding.id, failing))
    expect(await Effect.runPromise(failingBindingsProgram())).toEqual([])
  })

  it('counts uploads waiting to write through by bound record', async () => {
    const conn = await aConnection(await aUser('Priya'))
    const id = await bind(
      conn,
      `room-${randomUUID()}`,
      await aRecord('Fund docs'),
    )
    for (const _ of [1, 2, 3])
      await aFiled({
        bindingId: id,
        connectionId: null,
        externalId: null,
      })
    const waiting = await Effect.runPromise(
      waitingExportsByRecordProgram('google'),
    )
    expect(waiting).toHaveLength(1)
    expect(waiting.at(0)).toMatchObject({ targetName: 'Fund docs', count: 3 })
  })
})
