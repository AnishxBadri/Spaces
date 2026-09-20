import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Note deletion (SPA-125), against the test database. The demo, proven
 * server-side: a note filed in two spaces, tagged against a company and
 * mentioning a person goes, and everything it fed stays — including the
 * document `derived_from` it, which keeps its blob, its `extracted_text` and
 * its `tsv` and loses only the edge.
 *
 * Imports are dynamic like the rest of the DB-coupled suite: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time and `vitest.setup.ts`
 * rewrites it per file.
 */

/** The distinctive word the search assertions look for. */
const BODY_WORD = 'quenchplate'

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/**
 * The demo fixture: one note, two spaces, a company it is tagged against and
 * mentions, a person it mentions, a document derived from it, and activity
 * rows on both sides of the note.
 */
async function buildDemoNote(tag: string) {
  const { db } = await import('@spaces/db')
  const { company, document, entity, entitySpace, link, note, person, space } =
    await import('@spaces/db/schema')
  const { activity } = await import('@spaces/db/schema/activity')
  const { sql } = await import('drizzle-orm')

  const author = await actorId()

  const spaceIds: Array<string> = []
  for (const suffix of ['a', 'b']) {
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `NoteSpace ${suffix} ${tag}` })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: ent.id,
      slug: `notespace_${suffix}_${tag}`,
      path: `n_${suffix}_${tag}`,
    })
    spaceIds.push(ent.id)
  }

  const [co] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: `Kestrel ${tag}` })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: co.id })

  const [who] = await db
    .insert(entity)
    .values({ kind: 'person', canonicalName: `Ada ${tag}` })
    .returning({ id: entity.id })
  await db.insert(person).values({ entityId: who.id })

  const [noteEnt] = await db
    .insert(entity)
    .values({
      kind: 'note',
      canonicalName: `Teardown ${tag}`,
      createdBy: author,
    })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: noteEnt.id,
    title: `Teardown ${tag}`,
    bodyMd: `The ${BODY_WORD} is the whole thesis.`,
    authorId: author,
  })

  // Filed in both spaces — entity_space, the one filing mechanism for every
  // kind (CONTEXT.md → Filed vs referenced).
  for (const spaceId of spaceIds) {
    await db
      .insert(entitySpace)
      .values({ entityId: noteEnt.id, spaceId, source: 'manual' })
  }

  // Tagged against the company *and* mentioning it: the company page's Notes
  // section reads `mentions` today and `tagged_in` is what the filing decision
  // says it will read, so both must be gone afterwards for the criterion to
  // hold either way.
  await db.insert(link).values([
    {
      fromEntityId: noteEnt.id,
      toEntityId: co.id,
      relation: 'tagged_in',
      source: 'manual',
    },
    {
      fromEntityId: noteEnt.id,
      toEntityId: co.id,
      relation: 'mentions',
      source: 'extracted',
    },
    {
      fromEntityId: noteEnt.id,
      toEntityId: who.id,
      relation: 'mentions',
      source: 'extracted',
    },
  ])

  // The exported-memo PDF: a document whose only tie to the note is the edge.
  // `other` and not a `memo` kind — document_kind lost that label (SPA-25);
  // the `derived_from` edge below is what says this PDF is the memo.
  const [doc] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: `teardown-${tag}.pdf` })
    .returning({ id: entity.id })
  await db.insert(document).values({
    entityId: doc.id,
    blobSha: 'a'.repeat(64),
    filename: `teardown-${tag}.pdf`,
    kind: 'other',
    sourceClass: 'manual',
    extractedText: `The ${BODY_WORD} is the whole thesis.`,
    tsv: sql`to_tsvector('english', ${`The ${BODY_WORD} is the whole thesis.`})`,
    extractionStatus: 'done',
  })
  await db.insert(link).values({
    fromEntityId: doc.id,
    toEntityId: noteEnt.id,
    relation: 'derived_from',
    source: 'manual',
  })

  await db.insert(activity).values([
    {
      actorId: author,
      verb: 'note.created',
      subjectEntityId: co.id,
      objectEntityId: noteEnt.id,
    },
    {
      actorId: author,
      verb: 'note.created',
      subjectEntityId: noteEnt.id,
      objectEntityId: null,
    },
  ])

  return {
    author,
    noteId: noteEnt.id,
    companyId: co.id,
    personId: who.id,
    docId: doc.id,
    spaceIds,
  }
}

/**
 * `note_hits` — the Cmd-K palette's note source — is a CTE over the `note`
 * table itself, not a materialized index: `searchAll` reads
 * `from note n join entity e ... where n.tsv @@ websearch_to_tsquery(...)`.
 * So this is the same row set the palette would fuse, and an empty answer
 * here means the search row is gone rather than merely unreachable.
 */
async function noteHits(q: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { sql } = await import('drizzle-orm')
  const rows = await db.execute<{ id: string }>(sql`
    select n.entity_id as id
    from note n
    join entity e on e.id = n.entity_id and e.merged_into_id is null
    where n.tsv @@ websearch_to_tsquery('english', ${q})
  `)
  return rows.rows.map((r) => r.id)
}

describe('deleteNote', () => {
  it('takes its filings and edges, and leaves every record it named standing', async () => {
    const { deleteNoteProgram } = await import('./delete')
    const { db } = await import('@spaces/db')
    const { entity, entitySpace, link, note } =
      await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { and, eq, or } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const built = await buildDemoNote(tag)

    // Before: the note is a search row, and the company's Notes section lists it.
    expect(await noteHits(BODY_WORD)).toContain(built.noteId)

    const outcome = await Effect.runPromise(
      deleteNoteProgram(built.author, built.noteId),
    )
    expect(outcome).toEqual({ deleted: true })

    const empty = async (rows: Promise<Array<unknown>>) =>
      expect(await rows).toHaveLength(0)

    // The note and everything that was only about the note.
    await empty(db.select().from(note).where(eq(note.entityId, built.noteId)))
    await empty(db.select().from(entity).where(eq(entity.id, built.noteId)))
    await empty(
      db
        .select()
        .from(entitySpace)
        .where(eq(entitySpace.entityId, built.noteId)),
    )
    await empty(
      db
        .select()
        .from(link)
        .where(
          or(
            eq(link.fromEntityId, built.noteId),
            eq(link.toEntityId, built.noteId),
          ),
        ),
    )
    await empty(
      db
        .select()
        .from(activity)
        .where(
          or(
            eq(activity.subjectEntityId, built.noteId),
            eq(activity.objectEntityId, built.noteId),
          ),
        ),
    )

    // The company's Notes section — the query companies.ts runs — no longer
    // lists it, and neither would the `tagged_in` read the filing decision
    // calls for.
    await empty(
      db
        .select()
        .from(link)
        .where(
          and(
            eq(link.toEntityId, built.companyId),
            eq(link.relation, 'mentions'),
          ),
        ),
    )
    await empty(
      db
        .select()
        .from(link)
        .where(
          and(
            eq(link.toEntityId, built.companyId),
            eq(link.relation, 'tagged_in'),
          ),
        ),
    )

    // Cmd-K: the search row is gone because the row it was computed from is.
    expect(await noteHits(BODY_WORD)).not.toContain(built.noteId)

    // Untouched: both spaces, the company, the person.
    for (const id of [built.companyId, built.personId, ...built.spaceIds]) {
      expect(
        await db.select().from(entity).where(eq(entity.id, id)),
      ).toHaveLength(1)
    }
  })

  it('leaves a document derived_from the note whole — only the edge goes', async () => {
    const { deleteNoteProgram } = await import('./delete')
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq, sql } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const built = await buildDemoNote(tag)

    const before = (
      await db
        .select({
          blobSha: document.blobSha,
          extractedText: document.extractedText,
          // tsvector has no JS representation worth comparing; its text form
          // does, and it is what `doc_hits` matches against.
          tsv: sql<string>`${document.tsv}::text`,
        })
        .from(document)
        .where(eq(document.entityId, built.docId))
    ).at(0)
    // The english stemmer drops the trailing 'e', which is why this matches a
    // prefix of the word rather than the word.
    expect(before?.tsv).toMatch(/quenchplat/)

    await Effect.runPromise(deleteNoteProgram(built.author, built.noteId))

    const after = (
      await db
        .select({
          blobSha: document.blobSha,
          extractedText: document.extractedText,
          tsv: sql<string>`${document.tsv}::text`,
        })
        .from(document)
        .where(eq(document.entityId, built.docId))
    ).at(0)
    expect(after).toEqual(before)
  })

  it('refuses the mandate’s note by name, in words the dialog can show', async () => {
    const { Blocked } = await import('#/lib/entities/delete')
    const { deleteNoteProgram, noteDeleteImpactProgram, noteDeleteMessage } =
      await import('./delete')
    const { db } = await import('@spaces/db')
    const { entity, note } = await import('@spaces/db/schema')
    const { mandate } = await import('@spaces/db/schema/workspace')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const [noteEnt] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: `Mandate ${tag}` })
      .returning({ id: entity.id })
    await db.insert(note).values({
      entityId: noteEnt.id,
      title: `Mandate ${tag}`,
      authorId: author,
    })
    await db.insert(mandate).values({ noteEntityId: noteEnt.id })

    // The typed failure, not a thrown string: `Effect.flip` puts it in the
    // success channel so the assertion is about the value.
    const failure = await Effect.runPromise(
      Effect.flip(deleteNoteProgram(author, noteEnt.id)),
    )
    expect(failure).toBeInstanceOf(Blocked)
    if (failure._tag !== 'Blocked') throw new Error('expected Blocked')
    expect(failure.key).toBe('mandate.note')
    // What the server fn hands the client: the reason by name, not an empty
    // `message` off a Schema.TaggedError.
    expect(noteDeleteMessage(failure)).toBe(failure.reason)
    expect(noteDeleteMessage(failure)).toMatch(/mandate/)

    // And the dialog learns it before it offers a button.
    const impact = await Effect.runPromise(
      noteDeleteImpactProgram(author, noteEnt.id),
    )
    expect(impact.blockedReason).toBe(failure.reason)

    expect(
      await db.select().from(note).where(eq(note.entityId, noteEnt.id)),
    ).toHaveLength(1)
  })

  it('answers “Note not found” for someone else’s private note', async () => {
    const { NoteNotFound } = await import('./delete')
    const { deleteNoteProgram, noteDeleteMessage } = await import('./delete')
    const { db } = await import('@spaces/db')
    const { entity, note } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [other] = await db
      .insert(user)
      .values({
        id: `spa125-other-${tag}`,
        name: 'The Other Partner',
        email: `other-${tag}@spaces.test`,
      })
      .returning({ id: user.id })

    const [noteEnt] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: `Private ${tag}` })
      .returning({ id: entity.id })
    await db.insert(note).values({
      entityId: noteEnt.id,
      title: `Private ${tag}`,
      authorId: other.id,
      visibility: 'private',
    })

    const failure = await Effect.runPromise(
      Effect.flip(deleteNoteProgram(await actorId(), noteEnt.id)),
    )
    expect(failure).toBeInstanceOf(NoteNotFound)
    // The same words a nonexistent note gets: the error must not confirm the
    // note exists.
    expect(noteDeleteMessage(failure)).toBe('Note not found')
    const absent = await Effect.runPromise(
      Effect.flip(deleteNoteProgram(await actorId(), randomUUID())),
    )
    expect(noteDeleteMessage(absent)).toBe('Note not found')

    expect(
      await db.select().from(note).where(eq(note.entityId, noteEnt.id)),
    ).toHaveLength(1)
  })

  it('names what is about to be unlinked, and deletes what is already gone without complaint', async () => {
    const { deleteNoteProgram, noteDeleteImpactProgram } =
      await import('./delete')

    const tag = randomUUID().slice(0, 8)
    const built = await buildDemoNote(tag)

    const impact = await Effect.runPromise(
      noteDeleteImpactProgram(built.author, built.noteId),
    )
    expect(impact.blockedReason).toBeNull()
    expect(impact.title).toBe(`Teardown ${tag}`)
    expect(impact.unlinks.map((u) => u.meta).sort()).toEqual([
      'derived from this note',
      'filed against',
      'filed in space',
      'filed in space',
      'mentioned here',
      'mentioned here',
    ])
    expect(
      impact.unlinks.filter((u) => u.name === `Kestrel ${tag}`),
    ).toHaveLength(2)

    expect(
      await Effect.runPromise(deleteNoteProgram(built.author, built.noteId)),
    ).toEqual({ deleted: true })
    // A second click is the same outcome, not an error — but the note is no
    // longer readable, so it is "not found" rather than "already deleted".
    const second = await Effect.runPromise(
      Effect.flip(deleteNoteProgram(built.author, built.noteId)),
    )
    expect(second._tag).toBe('NoteNotFound')
  })
})
