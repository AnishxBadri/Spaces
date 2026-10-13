import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, entity, storageBinding } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { NOT_BINDABLE } from '@spaces/core/writes/bindings/bind'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  linkFolderProgram,
  recordBindingsForProgram,
  unlinkFolderProgram,
} from './bindings'
import type { LinkFolderInput } from './bindings'

/**
 * Link a Drive folder, web's half: Connect with no Drive, Google's consent
 * for `drive.readonly` when the connection holds only `drive.file`, the
 * job once it holds both, and what the Files tab reads back.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const RETURN = '/deals/1'

const OPTIONS = {
  mapSubfolders: true,
  retain: 'full',
  direction: 'pull',
  sensitivity: 'inherit',
} as const

beforeEach(async () => {
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

const aRecord = async (kind: 'deal' | 'person') => {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: `Ohmium ${randomUUID().slice(0, 6)}` })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no record')
  return row.id
}

const aDrive = async (scopes: Array<string>) => {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'drive',
        externalEmail: `${randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' },
          { userId: FIXTURE_ACTOR.id, provider: 'google' },
        ),
        scopes,
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return row.id
}

const link = (input: LinkFolderInput) =>
  Effect.runPromise(linkFolderProgram(FIXTURE_ACTOR.id, input))

const input = (attachTo: string): LinkFolderInput => ({
  folder: { id: 'dataroom' },
  attachTo,
  options: OPTIONS,
  returnTo: RETURN,
})

describe('linkFolderProgram', () => {
  it('offers Connect Drive with no connection, and offers no link', async () => {
    const deal = await aRecord('deal')
    const outcome = await link(input(deal))
    expect(outcome).toMatchObject({ _tag: 'connect', label: 'Connect Drive' })
    const read = await Effect.runPromise(
      recordBindingsForProgram(FIXTURE_ACTOR.id, deal),
    )
    expect(read).toEqual({ bindings: [], canLink: false })
  })

  it('asks Google for drive.readonly when the connection holds only drive.file', async () => {
    const deal = await aRecord('deal')
    await aDrive(['openid', 'email', 'drive.file'])
    const outcome = await link(input(deal))
    if (outcome._tag !== 'consent') throw new Error(`got ${outcome._tag}`)
    const href = new URL(outcome.href, 'http://localhost')
    expect(href.pathname).toBe('/api/connections/google/start')
    expect(href.searchParams.get('product')).toBe('drive')
    expect(href.searchParams.get('scopes')).toBe('drive.readonly')
    expect(href.searchParams.get('return')).toBe(RETURN)
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([])
  })

  it('queues the bind with the user’s connection once drive.readonly is held', async () => {
    const deal = await aRecord('deal')
    const connectionId = await aDrive([
      'openid',
      'email',
      'drive.file',
      'drive.readonly',
    ])
    const outcome = await link(input(deal))
    if (outcome._tag !== 'queued') throw new Error(`got ${outcome._tag}`)
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      {
        name: QUEUES.bindStorageFolder,
        data: {
          connectionId,
          folder: { id: 'dataroom' },
          targetEntityId: deal,
          actorUserId: FIXTURE_ACTOR.id,
          options: OPTIONS,
        },
        options: { singletonKey: outcome.bindId },
      },
    ])
  })

  it('refuses a person, whose Files tab offers no link', async () => {
    const person = await aRecord('person')
    await aDrive(['openid', 'email', 'drive.file', 'drive.readonly'])
    expect(await link(input(person))).toEqual({
      _tag: 'refused',
      reason: NOT_BINDABLE,
    })
    const read = await Effect.runPromise(
      recordBindingsForProgram(FIXTURE_ACTOR.id, person),
    )
    expect(read.canLink).toBe(false)
  })
})

describe('recordBindingsForProgram and unlink', () => {
  it('reads a bound folder as never synced, and Unlink removes it', async () => {
    const deal = await aRecord('deal')
    const connectionId = await aDrive(['openid', 'email', 'drive.file'])
    const row = (
      await db
        .insert(storageBinding)
        .values({
          connectionId,
          provider: 'google',
          folderId: 'dataroom',
          folderPath: 'My Drive / Acme Data Room',
          ancestorIds: ['root'],
          targetEntityId: deal,
          boundBy: FIXTURE_ACTOR.id,
        })
        .returning({ id: storageBinding.id })
    ).at(0)
    if (row === undefined) throw new Error('no binding')

    const read = await Effect.runPromise(
      recordBindingsForProgram(FIXTURE_ACTOR.id, deal),
    )
    expect(read.canLink).toBe(true)
    expect(read.bindings).toMatchObject([
      {
        id: row.id,
        folderPath: 'My Drive / Acme Data Room',
        direction: 'pull',
        lastSyncedAt: null,
      },
    ])

    expect(await Effect.runPromise(unlinkFolderProgram(row.id))).toBe(true)
    const after = await Effect.runPromise(
      recordBindingsForProgram(FIXTURE_ACTOR.id, deal),
    )
    expect(after.bindings).toEqual([])
  })
})
