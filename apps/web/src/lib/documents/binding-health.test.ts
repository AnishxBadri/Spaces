import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  entity,
  storageBinding,
  user,
} from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  accountBindingsForProgram,
  failingBindingsForProgram,
  rebindFolderProgram,
  rebindStatusOf,
} from './binding-health'

/**
 * Binding health, web's half: the account page's read, Re-bind sent only
 * with the reader's own connection, a check's status off its job, and
 * Today's failing lines pointed at the reader's account page.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

beforeEach(async () => {
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

const aDrive = async (
  userId: string,
  email = `${randomUUID()}@fund.example`,
) => {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'google',
        product: 'drive',
        externalEmail: email,
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

const priya = async () => {
  const id = `priya-${randomUUID()}`
  await db
    .insert(user)
    .values({ id, name: 'Priya', email: `${id}@fund.example` })
  return id
}

const bindOn = async (connectionId: string, name: string) => {
  const target = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (target === undefined) throw new Error('no record')
  const bound = await Effect.runPromise(
    bindFolderProgram({
      connectionId,
      provider: 'google',
      folder: {
        folderId: `f-${randomUUID()}`,
        ancestorIds: ['root'],
        path: `My Drive / ${name} / Legal`,
      },
      targetEntityId: target.id,
      boundBy: FIXTURE_ACTOR.id,
      options: {
        mapSubfolders: false,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
    }),
  )
  return bound.id
}

const fail = (id: string) =>
  db
    .update(storageBinding)
    .set({ status: 'error', error: 'Google said: File not found' })
    .where(eq(storageBinding.id, id))

describe('accountBindingsForProgram', () => {
  it('reads the account’s bindings and another member’s failing one, with the reader’s connections to re-bind with', async () => {
    const mine = await aDrive(FIXTURE_ACTOR.id)
    const theirs = await aDrive(await priya())
    const own = await bindOn(mine, 'Flent')
    const failing = await bindOn(theirs, 'Vayu')
    await bindOn(theirs, 'Acme')
    await fail(failing)

    const view = await Effect.runPromise(
      accountBindingsForProgram(FIXTURE_ACTOR.id, mine),
    )
    expect(view?.bindings.map((b) => [b.id, b.onAccount])).toEqual([
      [own, true],
      [failing, false],
    ])
    expect(view?.choices).toEqual([
      {
        connectionId: mine,
        email: expect.any(String),
        label: 'Drive',
        status: 'active',
      },
    ])
  })

  it('is null for a connection that is not the reader’s', async () => {
    const theirs = await aDrive(await priya())
    expect(
      await Effect.runPromise(
        accountBindingsForProgram(FIXTURE_ACTOR.id, theirs),
      ),
    ).toBeNull()
  })
})

describe('rebindFolderProgram', () => {
  it('sends the check as the reader with their own connection', async () => {
    const mine = await aDrive(FIXTURE_ACTOR.id)
    const binding = await bindOn(await aDrive(await priya()), 'Vayu')
    const sent = await Effect.runPromise(
      rebindFolderProgram(FIXTURE_ACTOR.id, {
        bindingId: binding,
        connectionId: mine,
        commit: false,
      }),
    )
    expect(sent._tag).toBe('queued')
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      {
        name: QUEUES.rebindStorageFolder,
        data: {
          bindingId: binding,
          connectionId: mine,
          commit: false,
          actorUserId: FIXTURE_ACTOR.id,
        },
        options: {
          singletonKey: sent._tag === 'queued' ? sent.checkId : '',
        },
      },
    ])
  })

  it('refuses someone else’s connection and sends nothing', async () => {
    const theirs = await aDrive(await priya())
    const binding = await bindOn(theirs, 'Vayu')
    expect(
      await Effect.runPromise(
        rebindFolderProgram(FIXTURE_ACTOR.id, {
          bindingId: binding,
          connectionId: theirs,
          commit: true,
        }),
      ),
    ).toEqual({ _tag: 'refused', reason: 'Not your connection' })
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([])
  })
})

describe('rebindStatusOf', () => {
  const at = (ms: number) => new Date(ms)
  it('is checking until the job settles, then the passed line or the refusal', () => {
    expect(rebindStatusOf(null)).toEqual({ state: 'checking' })
    expect(
      rebindStatusOf([{ state: 'active', output: null, createdOn: at(1) }]),
    ).toEqual({ state: 'checking' })
    expect(
      rebindStatusOf([
        {
          state: 'completed',
          output: { reason: 'Can read the folder · 41 files · drive.readonly' },
          createdOn: at(1),
        },
      ]),
    ).toEqual({
      state: 'passed',
      line: 'Can read the folder · 41 files · drive.readonly',
    })
    expect(
      rebindStatusOf([
        {
          state: 'failed',
          output: { reason: 'Google said: notFound · nothing changed' },
          createdOn: at(1),
        },
      ]),
    ).toEqual({
      state: 'refused',
      reason: 'Google said: notFound · nothing changed',
    })
  })
})

describe('failingBindingsForProgram', () => {
  it('one line per failing binding, fixed on the reader’s own account page; none once resolved', async () => {
    const mine = await aDrive(FIXTURE_ACTOR.id)
    const theirs = await aDrive(await priya())
    const failing = await bindOn(theirs, 'Vayu')
    await bindOn(theirs, 'Acme')
    await fail(failing)

    expect(
      await Effect.runPromise(failingBindingsForProgram(FIXTURE_ACTOR.id)),
    ).toEqual([
      {
        bindingId: failing,
        title: 'Vayu — Legal',
        error: 'Google said: File not found',
        fixConnectionId: mine,
      },
    ])
    await db
      .update(storageBinding)
      .set({ status: 'active', error: null })
      .where(eq(storageBinding.id, failing))
    expect(
      await Effect.runPromise(failingBindingsForProgram(FIXTURE_ACTOR.id)),
    ).toEqual([])
  })

  it('points a reader with no Drive at Files', async () => {
    const failing = await bindOn(await aDrive(await priya()), 'Vayu')
    await fail(failing)
    const lines = await Effect.runPromise(
      failingBindingsForProgram(FIXTURE_ACTOR.id),
    )
    expect(lines.map((l) => l.fixConnectionId)).toEqual([null])
  })
})
