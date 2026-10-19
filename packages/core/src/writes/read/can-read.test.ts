import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  chunk,
  document,
  emailGrant,
  emailVisibility,
  entity,
  interaction,
  interactionDocument,
  interactionEntity,
  link,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { canRead } from '../../read-policy'
import { SimilarLaneEmpty } from '../../context/similar-lane'
import { recordContextProgram } from '../context/record'
import {
  canReadDocumentSql,
  canReadNoteSql,
  documentWidenedSql,
  noteWidenedSql,
} from './can-read-sql'

/**
 * canRead and its SQL twins give one answer for every row: the pure
 * predicate, `canReadNoteSql` over `e` and `canReadDocumentSql` over the
 * document row. A private document is its author's alone, as a note is,
 * until D67's record override or a grant opens a synced email's body and
 * attachments to someone else.
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
const THIRD = {
  id: 'can-read-third',
  name: 'Third',
  email: 'third@can-read.test',
}

beforeEach(async () => {
  await db.insert(user).values([OWNER, OTHER, THIRD]).onConflictDoNothing()
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

// ---------- D67's widening layers ----------

async function makeRecord(kind: 'company' | 'deal', name: string) {
  const e = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!e) throw new Error('no record')
  return e.id
}

/** A synced email on `recordId`: a private body and a private attachment, both the owner's. */
async function makeEmail(
  recordId: string,
  kind: 'email' | 'call' = 'email',
): Promise<{ interactionId: string; body: string; attachment: string }> {
  const body = await makeNote('private', OWNER.id)
  const attachment = await makeDocument('private', OWNER.id)
  const row = (
    await db
      .insert(interaction)
      .values({
        kind,
        subject: 'Flent — Q3',
        noteId: body,
        occurredAt: new Date('2026-10-01T09:00:00Z'),
      })
      .returning({ id: interaction.id })
  ).at(0)
  if (!row) throw new Error('no interaction')
  await db
    .insert(interactionEntity)
    .values({ interactionId: row.id, entityId: recordId })
  await db.insert(interactionDocument).values({
    interactionId: row.id,
    documentId: attachment,
    role: 'attachment',
  })
  return { interactionId: row.id, body, attachment }
}

const override = (entityId: string, userId: string) =>
  db.insert(emailVisibility).values({ entityId, userId })

const grant = (interactionId: string, userId: string) =>
  db.insert(emailGrant).values({ interactionId, userId, grantedBy: OWNER.id })

/** The pure predicate's input for `id`, `widened` resolved for `viewer`. */
async function noteGate(viewer: string, id: string) {
  const row = (
    await db
      .select({
        visibility: note.visibility,
        authorId: note.authorId,
        widened: noteWidenedSql(viewer),
      })
      .from(note)
      .where(sql`${note.entityId} = ${id}`)
  ).at(0)
  if (!row) throw new Error('no note')
  return row
}

async function documentGate(viewer: string, id: string) {
  const row = (
    await db
      .select({
        visibility: document.visibility,
        authorId: document.authorId,
        widened: documentWidenedSql(viewer),
      })
      .from(document)
      .where(sql`${document.entityId} = ${id}`)
  ).at(0)
  if (!row) throw new Error('no document')
  return row
}

type Fixture = {
  flent: string
  email: { interactionId: string; body: string; attachment: string }
}

const WIDENING_CASES: ReadonlyArray<{
  name: string
  setup: (f: Fixture) => Promise<unknown>
  other: boolean
  third: boolean
  kind?: 'call'
}> = [
  { name: 'no layer', setup: async () => {}, other: false, third: false },
  {
    name: 'a grant to Other',
    setup: (f) => grant(f.email.interactionId, OTHER.id),
    other: true,
    third: false,
  },
  {
    name: 'the owner’s override on the record',
    setup: (f) => override(f.flent, OWNER.id),
    other: true,
    third: true,
  },
  {
    name: 'the owner’s override on another record',
    setup: async () => override(await makeRecord('company', 'Acme'), OWNER.id),
    other: false,
    third: false,
  },
  {
    name: 'an override on the record by someone not the owner',
    setup: (f) => override(f.flent, OTHER.id),
    other: false,
    third: false,
  },
  {
    name: 'the owner’s override on a deal deriving the record',
    setup: async (f) => {
      const deal = await makeRecord('deal', 'Flent seed')
      await db.insert(link).values({
        fromEntityId: deal,
        toEntityId: f.flent,
        relation: 'references',
        attrSlug: 'company',
        source: 'manual',
      })
      return override(deal, OWNER.id)
    },
    other: true,
    third: true,
  },
  {
    name: 'a grant on a sibling email',
    setup: async (f) =>
      grant((await makeEmail(f.flent)).interactionId, OTHER.id),
    other: false,
    third: false,
  },
  {
    name: 'the override removed, a grant to Other kept',
    setup: async (f) => {
      await override(f.flent, OWNER.id)
      await grant(f.email.interactionId, OTHER.id)
      await db
        .delete(emailVisibility)
        .where(sql`${emailVisibility.entityId} = ${f.flent}`)
    },
    other: true,
    third: false,
  },
  {
    name: 'the owner’s override over a private call write-up',
    setup: (f) => override(f.flent, OWNER.id),
    kind: 'call',
    other: false,
    third: false,
  },
]

describe('canRead and its SQL twins agree on a widened email', () => {
  for (const c of WIDENING_CASES)
    it(`under ${c.name}`, async () => {
      const flent = await makeRecord('company', 'Flent')
      const email = await makeEmail(flent, c.kind ?? 'email')
      await c.setup({ flent, email })
      const expected = new Map([
        [OWNER.id, true],
        [OTHER.id, c.other],
        [THIRD.id, c.third],
      ])
      for (const viewer of [OWNER, OTHER, THIRD]) {
        const want = expected.get(viewer.id)
        expect(canRead(viewer, await noteGate(viewer.id, email.body))).toBe(
          want,
        )
        expect(await entityLane(viewer.id, email.body)).toBe(want)
        expect(
          canRead(viewer, await documentGate(viewer.id, email.attachment)),
        ).toBe(want)
        expect(await entityLane(viewer.id, email.attachment)).toBe(want)
        expect(await documentRow(viewer.id, email.attachment)).toBe(want)
      }
    })

  it('leaves a private row its author’s when the caller resolves no widening', () => {
    expect(canRead(OTHER, { visibility: 'private', authorId: OWNER.id })).toBe(
      false,
    )
    expect(
      canRead(OTHER, {
        visibility: 'private',
        authorId: OWNER.id,
        widened: true,
      }),
    ).toBe(true)
  })
})
