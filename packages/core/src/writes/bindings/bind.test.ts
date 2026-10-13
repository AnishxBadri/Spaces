import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { eq, isNotNull } from 'drizzle-orm'
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
import {
  NOT_BINDABLE,
  bindFolderProgram,
  recordBindingsProgram,
  unlinkBindingProgram,
} from './bind'
import type { BindFolderInput } from './bind'

/** The bind-time guards against a real table: one folder, one owner node. */

const OPTIONS = {
  mapSubfolders: true,
  retain: 'full',
  direction: 'pull',
  sensitivity: 'inherit',
} as const

async function record(kind: 'company' | 'deal' | 'person', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no record')
  return row.id
}

async function connectionFor(userId: string) {
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
  if (row === undefined) throw new Error('no connection')
  return row.id
}

async function priya() {
  await db
    .insert(user)
    .values({ id: 'priya', name: 'Priya', email: 'priya@fund.example' })
    .onConflictDoNothing()
  return 'priya'
}

const FOLDERS = {
  ohmium: {
    folderId: 'ohmium',
    ancestorIds: ['root'],
    path: 'My Drive / Ohmium',
  },
  dataRoom: {
    folderId: 'dataroom',
    ancestorIds: ['root', 'ohmium'],
    path: 'My Drive / Ohmium / Data room',
  },
}

const bind = (input: BindFolderInput) =>
  Effect.runPromise(bindFolderProgram(input))

/** The sentence a refused bind is shown as. */
const refusal = (input: BindFolderInput) =>
  Effect.runPromise(Effect.flip(bindFolderProgram(input))).then((error) =>
    error._tag === 'BindingRefused' ? error.reason : error._tag,
  )

// Each case starts with no binding; the rows other tables hold are its own.
beforeEach(async () => {
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
})

describe('bindFolderProgram', () => {
  it('binds a folder with its options and ancestry, never synced', async () => {
    const deal = await record('deal', 'Ohmium Series B')
    const connectionId = await connectionFor(FIXTURE_ACTOR.id)
    await bind({
      connectionId,
      provider: 'google',
      folder: FOLDERS.dataRoom,
      targetEntityId: deal,
      boundBy: FIXTURE_ACTOR.id,
      options: { ...OPTIONS, retain: 'text', sensitivity: 'sensitive' },
    })
    const rows = await Effect.runPromise(recordBindingsProgram(deal))
    expect(rows).toMatchObject([
      {
        folderPath: 'My Drive / Ohmium / Data room',
        retain: 'text',
        sensitivity: 'sensitive',
        direction: 'pull',
        mapSubfolders: true,
        status: 'active',
        lastSyncedAt: null,
      },
    ])
    const stored = await db
      .select({ ancestorIds: storageBinding.ancestorIds })
      .from(storageBinding)
    expect(stored).toEqual([{ ancestorIds: ['root', 'ohmium'] }])
  })

  it('refuses a folder inside a bound one, and a parent of a bound one, naming the binding and its target', async () => {
    const company = await record('company', 'Ohmium')
    const deal = await record('deal', 'Ohmium Series B')
    const connectionId = await connectionFor(FIXTURE_ACTOR.id)
    const base = {
      connectionId,
      provider: 'google',
      boundBy: FIXTURE_ACTOR.id,
      options: OPTIONS,
    }
    await bind({ ...base, folder: FOLDERS.ohmium, targetEntityId: company })
    expect(
      await refusal({
        ...base,
        folder: FOLDERS.dataRoom,
        targetEntityId: deal,
      }),
    ).toBe(
      'My Drive / Ohmium / Data room is inside My Drive / Ohmium, which is linked to Ohmium. A folder has one owner.',
    )

    await db.delete(storageBinding).where(isNotNull(storageBinding.id))
    await bind({ ...base, folder: FOLDERS.dataRoom, targetEntityId: deal })
    expect(
      await refusal({
        ...base,
        folder: FOLDERS.ohmium,
        targetEntityId: company,
      }),
    ).toBe(
      'My Drive / Ohmium holds My Drive / Ohmium / Data room, which is linked to Ohmium Series B. A folder has one owner.',
    )
  })

  it('refuses a folder already bound on another user’s connection, naming the binder', async () => {
    const deal = await record('deal', 'Ohmium Series B')
    const other = await record('company', 'Ohmium')
    const theirs = await connectionFor(await priya())
    const mine = await connectionFor(FIXTURE_ACTOR.id)
    await bind({
      connectionId: theirs,
      provider: 'google',
      folder: FOLDERS.dataRoom,
      targetEntityId: deal,
      boundBy: 'priya',
      options: OPTIONS,
    })
    const reason = await refusal({
      connectionId: mine,
      provider: 'google',
      folder: FOLDERS.dataRoom,
      targetEntityId: other,
      boundBy: FIXTURE_ACTOR.id,
      options: OPTIONS,
    })
    expect(reason).toBe(
      'My Drive / Ohmium / Data room is already linked to Ohmium Series B by Priya.',
    )
  })

  it('refuses a person as the target', async () => {
    const person = await record('person', 'Asha')
    const reason = await refusal({
      connectionId: await connectionFor(FIXTURE_ACTOR.id),
      provider: 'google',
      folder: FOLDERS.ohmium,
      targetEntityId: person,
      boundBy: FIXTURE_ACTOR.id,
      options: OPTIONS,
    })
    expect(reason).toBe(NOT_BINDABLE)
  })

  it('unlinks: the row goes, a document it filed stays with binding_id null', async () => {
    const deal = await record('deal', 'Ohmium Series B')
    const bound = await bind({
      connectionId: await connectionFor(FIXTURE_ACTOR.id),
      provider: 'google',
      folder: FOLDERS.dataRoom,
      targetEntityId: deal,
      boundBy: FIXTURE_ACTOR.id,
      options: OPTIONS,
    })
    const docId = await record('company', 'placeholder')
    await db
      .update(entity)
      .set({ kind: 'document' })
      .where(eq(entity.id, docId))
    await db
      .insert(document)
      .values({ entityId: docId, filename: 'deck.pdf', bindingId: bound.id })

    expect(await Effect.runPromise(unlinkBindingProgram(bound.id))).toBe(true)
    expect(await Effect.runPromise(recordBindingsProgram(deal))).toEqual([])
    const kept = await db
      .select({ bindingId: document.bindingId })
      .from(document)
      .where(eq(document.entityId, docId))
    expect(kept).toEqual([{ bindingId: null }])
    expect(await Effect.runPromise(unlinkBindingProgram(bound.id))).toBe(false)
  })
})
