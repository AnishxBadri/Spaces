import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Follow, web's half, against the test database: a readable document a
 * connection brought is followed from a company, the Files tab's row reads
 * the binding back, a person's tab offers no Follow, a private file of
 * someone else is refused, and the revision ledger counts from the
 * document's birth. Dynamic imports: `@spaces/db` builds its pool from
 * `DATABASE_URL` at import time and the vitest setup rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

async function aRecord(kind: 'company' | 'person' | 'document') {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const [row] = await db
    .insert(entity)
    .values({ kind, canonicalName: `${kind} ${randomUUID().slice(0, 6)}` })
    .returning({ id: entity.id })
  return row.id
}

async function aConnection(userId: string) {
  const { db } = await import('@spaces/db')
  const { accountConnection } = await import('@spaces/db/schema')
  const { encryptBundle } =
    await import('@spaces/core/writes/connections/bundle')
  const [row] = await db
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
      scopes: ['openid', 'email', 'drive.file'],
    })
    .returning({ id: accountConnection.id })
  return row.id
}

/** A file picked from Drive onto `recordId`. */
async function aPickedFile(
  recordId: string,
  over: { visibility?: 'shared' | 'private'; authorId?: string } = {},
) {
  const { db } = await import('@spaces/db')
  const { document, link } = await import('@spaces/db/schema')
  const actor = await actorId()
  const id = await aRecord('document')
  await db.insert(document).values({
    entityId: id,
    filename: 'Cap table.xlsx',
    connectionId: await aConnection(actor),
    externalId: `file-${randomUUID()}`,
    externalRevisionId: '7',
    externalStatus: 'linked',
    extractionStatus: 'done',
    visibility: over.visibility ?? 'shared',
    authorId: over.authorId ?? null,
  })
  await db.insert(link).values({
    fromEntityId: id,
    toEntityId: recordId,
    relation: 'tagged_in',
    createdBy: actor,
  })
  return id
}

async function follow(userId: string, documentId: string, recordId: string) {
  const { Effect } = await import('effect')
  const { followDocumentProgram } = await import('./follow')
  return Effect.runPromise(
    followDocumentProgram(userId, { documentId, recordId }),
  )
}

describe('followDocumentProgram', () => {
  it('follows a picked file from its company, and the Files tab row reads the binding', async () => {
    const actor = await actorId()
    const company = await aRecord('company')
    const id = await aPickedFile(company)
    const { recordDocumentRows } = await import('./record-files')
    const { followableRecord } = await import('./follow')

    const before = (await recordDocumentRows(actor, company)).at(0)
    expect(before).toMatchObject({
      followable: true,
      followStatus: null,
      priorRevisions: 0,
      revisedAt: null,
    })
    expect(await followableRecord(company)).toBe(true)

    const outcome = await follow(actor, id, company)
    expect(outcome._tag).toBe('followed')
    const after = (await recordDocumentRows(actor, company)).at(0)
    expect(after).toMatchObject({
      followStatus: 'active',
      followSyncedAt: null,
      bindingId: outcome._tag === 'followed' ? outcome.bindingId : null,
    })

    const { Effect } = await import('effect')
    const { unfollowDocumentProgram, documentRevisionsForProgram } =
      await import('./follow')
    expect(await Effect.runPromise(unfollowDocumentProgram(actor, id))).toBe(
      true,
    )
    expect((await recordDocumentRows(actor, company)).at(0)).toMatchObject({
      followStatus: 'paused',
    })
    const ledger = await Effect.runPromise(
      documentRevisionsForProgram(actor, id),
    )
    expect(ledger).toEqual([
      { rev: 1, revisionId: '7', at: expect.any(String), current: true },
    ])
  })

  it('a person’s Files tab offers no Follow, and following from one is refused', async () => {
    const actor = await actorId()
    const person = await aRecord('person')
    const id = await aPickedFile(person)
    const { followableRecord } = await import('./follow')
    expect(await followableRecord(person)).toBe(false)
    expect(await follow(actor, id, person)).toMatchObject({ _tag: 'refused' })
  })

  it('refuses a private file of someone else as if it were not there', async () => {
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const other = `user-${randomUUID()}`
    await db.insert(user).values({
      id: other,
      name: 'Priya',
      email: `${other}@fund.example`,
      emailVerified: true,
    })
    const actor = await actorId()
    const company = await aRecord('company')
    const id = await aPickedFile(company, {
      visibility: 'private',
      authorId: other,
    })
    expect(await follow(actor, id, company)).toEqual({
      _tag: 'refused',
      reason: 'That file no longer exists.',
    })
  })
})
