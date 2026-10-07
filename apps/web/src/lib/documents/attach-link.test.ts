import { Effect } from 'effect'
import { isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, company, entity } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  NOT_FETCHABLE,
  attachFromLinkProgram,
  attachLinkMessage,
  linkFetchStatusOf,
} from './attach-link'
import { storageLinkProvider } from './storage-link'

/**
 * Attach from a link, web half: which connection fetches it, or why none
 * can, and the poll's reading of the job. The fetch itself is the worker's
 * `document.fetch-storage`.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const LINK = 'https://drive.google.com/file/d/pitch/view'

beforeEach(async () => {
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

const aCompany = async () => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: 'Ohmium' })
      .returning({ id: entity.id })
  ).at(0)
  if (ent === undefined) throw new Error('no entity')
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

const aConnection = async (
  over: { status?: 'active' | 'error' | 'revoked'; errorReason?: string } = {},
) => {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'drive',
        externalEmail: `${crypto.randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' },
          { userId: FIXTURE_ACTOR.id, provider: 'google' },
        ),
        scopes: ['openid', 'email', 'drive.file'],
        status: over.status ?? 'active',
        errorReason: over.errorReason ?? null,
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return row.id
}

const attach = (url: string, attachTo: string) =>
  Effect.runPromise(
    attachFromLinkProgram(FIXTURE_ACTOR.id, {
      url,
      attachTo,
      returnTo: `/companies/${attachTo}`,
    }),
  )

describe('attachFromLinkProgram', () => {
  it('offers Connect, back to the record, when the user holds no Drive connection', async () => {
    const record = await aCompany()
    expect(await attach(LINK, record)).toEqual({
      _tag: 'connect',
      href: `/api/connections/google/start?product=drive&return=${encodeURIComponent(`/companies/${record}`)}`,
      label: 'Connect Drive',
    })
  })

  it('says the provider’s reason when the only connection is in error', async () => {
    const record = await aCompany()
    await aConnection({
      status: 'error',
      errorReason: 'invalid_grant: Token has been expired or revoked.',
    })
    expect(await attach(LINK, record)).toEqual({
      _tag: 'refused',
      reason: 'invalid_grant: Token has been expired or revoked.',
    })
  })

  it('queues the fetch on the user’s active connection, keyed for the poll', async () => {
    const record = await aCompany()
    await aConnection({ status: 'revoked' })
    const active = await aConnection()
    const outcome = await attach(LINK, record)
    if (outcome._tag !== 'queued') throw new Error(outcome._tag)
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      {
        name: QUEUES.fetchStorageFile,
        data: {
          url: LINK,
          connectionId: active,
          attachTo: record,
          actorUserId: FIXTURE_ACTOR.id,
        },
        options: { singletonKey: outcome.fetchId },
      },
    ])
  })

  it('refuses a link from no storage provider, and a target that is not a record', async () => {
    const record = await aCompany()
    await aConnection()
    await expect(
      attach(LINK, crypto.randomUUID()).catch((e: unknown) =>
        Promise.reject(new Error(attachLinkMessage(e))),
      ),
    ).rejects.toThrow('That record no longer exists.')
    await expect(
      Effect.runPromise(
        attachFromLinkProgram(FIXTURE_ACTOR.id, {
          url: 'https://example.com/deck.pdf',
          attachTo: record,
          returnTo: '/',
        }),
      ).catch((e: unknown) => Promise.reject(new Error(attachLinkMessage(e)))),
    ).rejects.toThrow(NOT_FETCHABLE)
  })
})

describe('linkFetchStatusOf', () => {
  const at = (ms: number) => new Date(ms)
  it('reads queued, retrying and running as fetching, and a failure’s reason', () => {
    expect(linkFetchStatusOf(null)).toEqual({ state: 'fetching' })
    expect(
      linkFetchStatusOf([{ state: 'retry', output: null, createdOn: at(1) }]),
    ).toEqual({ state: 'fetching' })
    expect(
      linkFetchStatusOf([{ state: 'completed', output: {}, createdOn: at(1) }]),
    ).toEqual({ state: 'done' })
    expect(
      linkFetchStatusOf([
        {
          state: 'failed',
          output: { kind: 'permanent', reason: 'Invalid Credentials' },
          createdOn: at(2),
        },
      ]),
    ).toEqual({ state: 'failed', reason: 'Invalid Credentials' })
  })
})

describe('storageLinkProvider', () => {
  it('knows Drive and Docs hosts and nothing else', () => {
    expect(storageLinkProvider(LINK)?.label).toBe('Drive')
    expect(
      storageLinkProvider('https://docs.google.com/document/d/memo/edit')
        ?.product,
    ).toBe('drive')
    expect(storageLinkProvider('https://www.dropbox.com/sh/abc')).toBeNull()
    expect(storageLinkProvider('not a url')).toBeNull()
  })
})
