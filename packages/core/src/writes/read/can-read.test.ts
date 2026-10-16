import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { chunk, document, entity, link, note } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { canRead } from '../../read-policy'
import { SimilarLaneEmpty } from '../../context/similar-lane'
import { recordContextProgram } from '../context/record'
import { canReadDocumentSql, canReadNoteSql } from './can-read-sql'

/**
 * canRead and its SQL twins give one answer for every row: the pure
 * predicate, `canReadNoteSql` over `e` and `canReadDocumentSql` over the
 * document row. A private document is its author's alone, as a note is.
 */

const OWNER = {
  id: 'can-read-owner',
  name: 'Owner',
  email: 'owner@can-read.test',
}
const OTHER = {
  id: 'can-read-other',
  name: 'Other',
  email: 'other@can-read.test',
}

beforeEach(async () => {
  await db.insert(user).values([OWNER, OTHER]).onConflictDoNothing()
})

type Visibility = 'shared' | 'private'

async function makeDocument(
  visibility: Visibility,
  authorId: string | null,
): Promise<string> {
  const e = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: 'Quokkaplan.pdf' })
      .returning({ id: entity.id })
  ).at(0)
  if (!e) throw new Error('no entity')
  // A test fixture, exempt from the one-writer rule.
  await db.insert(document).values({
    entityId: e.id,
    filename: 'Quokkaplan.pdf',
    visibility,
    authorId,
  })
  return e.id
}

async function makeNote(
  visibility: Visibility,
  authorId: string,
): Promise<string> {
  const e = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: 'A note' })
      .returning({ id: entity.id })
  ).at(0)
  if (!e) throw new Error('no entity')
  await db
    .insert(note)
    .values({ entityId: e.id, title: 'A note', authorId, visibility })
  return e.id
}

/** `canReadNoteSql` over `e`, the alias every search lane reads. */
const entityLane = async (viewer: string, id: string) =>
  (
    await db.execute<{ ok: boolean }>(
      sql`select ${canReadNoteSql(viewer)} as ok from entity e where e.id = ${id}`,
    )
  ).rows.at(0)?.ok

/** `canReadDocumentSql` over the document row, the Files tab's shape. */
const documentRow = async (viewer: string, id: string) =>
  (
    await db
      .select({ id: document.entityId })
      .from(document)
      .where(
        sql`${document.entityId} = ${id} and ${canReadDocumentSql(viewer)}`,
      )
  ).length > 0

const DOCUMENT_CASES: ReadonlyArray<{
  visibility: Visibility
  author: 'owner' | 'other' | null
}> = [
  { visibility: 'shared', author: null },
  { visibility: 'shared', author: 'owner' },
  { visibility: 'shared', author: 'other' },
  { visibility: 'private', author: null },
  { visibility: 'private', author: 'owner' },
  { visibility: 'private', author: 'other' },
]

const idOf = (who: 'owner' | 'other' | null) =>
  who === null ? null : who === 'owner' ? OWNER.id : OTHER.id

describe('canRead and its SQL twins agree', () => {
  for (const c of DOCUMENT_CASES)
    it(`on a ${c.visibility} document authored by ${c.author ?? 'nobody'}`, async () => {
      const authorId = idOf(c.author)
      const id = await makeDocument(c.visibility, authorId)
      for (const viewer of [OWNER, OTHER]) {
        const expected = canRead(viewer, { visibility: c.visibility, authorId })
        expect(await entityLane(viewer.id, id)).toBe(expected)
        expect(await documentRow(viewer.id, id)).toBe(expected)
      }
    })

  for (const visibility of ['shared', 'private'] as const)
    it(`on a ${visibility} note`, async () => {
      const id = await makeNote(visibility, OWNER.id)
      for (const viewer of [OWNER, OTHER])
        expect(await entityLane(viewer.id, id)).toBe(
          canRead(viewer, { visibility, authorId: OWNER.id }),
        )
    })

  it('private means the author only, for a document as for a note', async () => {
    const doc = await makeDocument('private', OWNER.id)
    expect(canRead(OWNER, { visibility: 'private', authorId: OWNER.id })).toBe(
      true,
    )
    expect(await documentRow(OWNER.id, doc)).toBe(true)
    expect(await documentRow(OTHER.id, doc)).toBe(false)
  })
})

describe('the assembler reads a document through canRead', () => {
  const contextOf = (viewer: { id: string }, entityId: string) =>
    recordContextProgram({
      entityId,
      user: viewer,
      asOf: '2026-10-16',
      budgetChars: 8000,
    }).pipe(Effect.provide(SimilarLaneEmpty))

  async function filedPrivateDeck() {
    const company = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: 'Acme' })
        .returning({ id: entity.id })
    ).at(0)
    if (!company) throw new Error('no company')
    const doc = await makeDocument('private', OWNER.id)
    await db.insert(chunk).values({
      entityId: doc,
      sourceKind: 'document',
      idx: 0,
      text: 'Quokka margins are thin.',
    })
    await db.insert(link).values({
      fromEntityId: doc,
      toEntityId: company.id,
      relation: 'tagged_in',
      source: 'manual',
    })
    return { company: company.id, doc }
  }

  it('leaves a private attachment out of a record’s context for anyone but its author', async () => {
    const { company, doc } = await filedPrivateDeck()
    const refs = async (viewer: { id: string }) =>
      (await Effect.runPromise(contextOf(viewer, company))).items.map(
        (i) => i.ref,
      )
    expect(await refs(OWNER)).toContain(`doc:${doc}#0`)
    expect((await refs(OTHER)).some((r) => r.startsWith(`doc:${doc}`))).toBe(
      false,
    )
  })

  it('answers a private document asked for as the seed as not found', async () => {
    const { doc } = await filedPrivateDeck()
    const failure = await Effect.runPromise(Effect.flip(contextOf(OTHER, doc)))
    expect(failure._tag).toBe('ContextEntityNotFound')
    const own = await Effect.runPromise(contextOf(OWNER, doc))
    expect(own.items.map((i) => i.ref)).toContain(`doc:${doc}#0`)
  })
})
