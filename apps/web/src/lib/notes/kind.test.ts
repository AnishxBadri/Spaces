import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Note kind (SPA-109), against the test database. Two things are being
 * pinned, and only one of them is the toggle.
 *
 * The toggle: three kinds, every transition between them, the unreadable
 * note collapsing to the same "Note not found" `getNote` gives, and a
 * teammate's shared note staying team-editable — kind is not visibility.
 *
 * The other thing is the harder one. `scratch` has sat in the pgEnum since
 * migration 0000 and has never been read: the moment it is writable,
 * something will be tempted to hide it. The last block below asserts that a
 * scratch note is still a note everywhere a note is — `listNotes`, the space
 * lanes, the Cmd-K search CTE, and the assembler, where it reaches the
 * ranker as `ContextKind 'note'`. Scratch ships as a label that suppresses
 * nothing; this is the test that says so.
 *
 * Imports are dynamic like the rest of the DB-coupled suite: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time and `vitest.setup.ts`
 * rewrites it per file.
 */

const BODY_WORD = 'thermosiphon'

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

async function makeUser(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db
    .insert(user)
    .values({
      id: `spa109-other-${tag}`,
      name: 'The Other Partner',
      email: `other-${tag}@spaces.test`,
    })
    .returning({ id: user.id })
  return row.id
}

/** One note, with an author and a kind — everything else is default. */
async function makeNote(opts: {
  tag: string
  authorId: string
  kind?: 'note' | 'memo' | 'scratch'
  visibility?: 'shared' | 'private'
  bodyMd?: string
}): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, note } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({
      kind: 'note',
      canonicalName: `Kind ${opts.tag}`,
      createdBy: opts.authorId,
    })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: ent.id,
    title: `Kind ${opts.tag}`,
    bodyMd: opts.bodyMd ?? '',
    authorId: opts.authorId,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
  })
  return ent.id
}

async function kindOf(id: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { note } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db
    .select({ kind: note.kind })
    .from(note)
    .where(eq(note.entityId, id))
  expect(rows).toHaveLength(1)
  return rows[0].kind
}

/**
 * `note_hits` — the note source of `searchAll`'s RRF fusion — is a CTE over
 * the `note` table itself, so running it here is the same row set the
 * palette would fuse, and it carries no `kind` predicate. An empty answer
 * means the palette would not show the note.
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

describe('setNoteKind', () => {
  it('walks all three kinds, and writes one activity row per move', async () => {
    const { setNoteKindProgram } = await import('./kind')
    const { db } = await import('@spaces/db')
    const { activity } = await import('@spaces/db/schema/activity')
    const { asc, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const id = await makeNote({ tag, authorId: me })
    expect(await kindOf(id)).toBe('note')

    for (const next of ['memo', 'scratch', 'note'] as const) {
      expect(await Effect.runPromise(setNoteKindProgram(me, id, next))).toEqual(
        { kind: next, changed: true },
      )
      expect(await kindOf(id)).toBe(next)
    }

    // Setting the kind it already has is the same answer, not an error —
    // and writes no row, so the stream holds moves only.
    expect(await Effect.runPromise(setNoteKindProgram(me, id, 'note'))).toEqual(
      { kind: 'note', changed: false },
    )

    const rows = await db
      .select({ verb: activity.verb, meta: activity.meta })
      .from(activity)
      .where(eq(activity.subjectEntityId, id))
      .orderBy(asc(activity.at))
    expect(rows.map((r) => r.verb)).toEqual([
      'note.kind_changed',
      'note.kind_changed',
      'note.kind_changed',
    ])
    expect(rows.map((r) => r.meta)).toEqual([
      { from: 'note', to: 'memo' },
      { from: 'memo', to: 'scratch' },
      { from: 'scratch', to: 'note' },
    ])
  })

  it('renders every verb it writes — no raw `note.kind_changed` in the timeline', async () => {
    const { VERB_LABELS, VERB_TYPES } =
      await import('#/components/record-timeline')
    expect(VERB_LABELS['note.kind_changed']).toBeTruthy()
    expect(VERB_TYPES['note.kind_changed']).toBe('note')
  })

  it('answers “Note not found” for a note that is not there and one that is not yours', async () => {
    const { NoteNotFound } = await import('./delete')
    const { noteKindMessage, setNoteKindProgram } = await import('./kind')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const other = await makeUser(tag)
    const theirs = await makeNote({
      tag,
      authorId: other,
      visibility: 'private',
    })

    const hidden = await Effect.runPromise(
      Effect.flip(setNoteKindProgram(me, theirs, 'memo')),
    )
    expect(hidden).toBeInstanceOf(NoteNotFound)
    expect(noteKindMessage(hidden)).toBe('Note not found')

    const absent = await Effect.runPromise(
      Effect.flip(setNoteKindProgram(me, randomUUID(), 'memo')),
    )
    // The same words: a distinct error would confirm the private note exists.
    expect(noteKindMessage(absent)).toBe('Note not found')

    expect(await kindOf(theirs)).toBe('note')
  })

  it('lets anyone who can read a shared note promote it — kind is not visibility', async () => {
    const { setNoteKindProgram } = await import('./kind')

    const tag = randomUUID().slice(0, 8)
    const other = await makeUser(tag)
    const theirs = await makeNote({ tag, authorId: other })

    // Written by someone else, shared, and promoted by me. `setNoteVisibility`
    // would refuse this; kind deliberately does not.
    expect(
      await Effect.runPromise(
        setNoteKindProgram(await actorId(), theirs, 'memo'),
      ),
    ).toEqual({ kind: 'memo', changed: true })
    expect(await kindOf(theirs)).toBe('memo')
  })

  it('promotes a note filed against a deal without touching one link, filing or byte of body', async () => {
    const { setNoteKindProgram } = await import('./kind')
    const { db } = await import('@spaces/db')
    const { entity, entitySpace, link, note, space } =
      await import('@spaces/db/schema')
    const { asc, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const id = await makeNote({
      tag,
      authorId: me,
      bodyMd: `The ${BODY_WORD} is the whole thesis.`,
    })

    const [deal] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `Kestrel Series B ${tag}` })
      .returning({ id: entity.id })
    const [spaceEnt] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `KindSpace ${tag}` })
      .returning({ id: entity.id })
    await db
      .insert(space)
      .values({ entityId: spaceEnt.id, slug: `kind_${tag}`, path: `k_${tag}` })

    await db.insert(link).values([
      {
        fromEntityId: id,
        toEntityId: deal.id,
        relation: 'tagged_in',
        source: 'manual',
      },
      {
        fromEntityId: id,
        toEntityId: deal.id,
        relation: 'mentions',
        source: 'extracted',
      },
    ])
    await db
      .insert(entitySpace)
      .values({ entityId: id, spaceId: spaceEnt.id, source: 'manual' })

    const edges = () =>
      db
        .select({
          from: link.fromEntityId,
          to: link.toEntityId,
          relation: link.relation,
          source: link.source,
        })
        .from(link)
        .where(eq(link.fromEntityId, id))
        .orderBy(asc(link.relation))
    const filings = () =>
      db
        .select({ spaceId: entitySpace.spaceId, source: entitySpace.source })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, id))
    const body = async () =>
      (
        await db
          .select({ bodyJson: note.bodyJson, bodyMd: note.bodyMd })
          .from(note)
          .where(eq(note.entityId, id))
      ).at(0)

    const edgesBefore = await edges()
    const filingsBefore = await filings()
    const bodyBefore = await body()
    expect(edgesBefore).toHaveLength(2)
    expect(filingsBefore).toHaveLength(1)

    await Effect.runPromise(setNoteKindProgram(me, id, 'memo'))

    // A memo is a note with the flag up: same row, same edges, same filing.
    expect(await kindOf(id)).toBe('memo')
    expect(await edges()).toEqual(edgesBefore)
    expect(await filings()).toEqual(filingsBefore)
    expect(await body()).toEqual(bodyBefore)

    // And the demote back is symmetric — nothing is one-way.
    await Effect.runPromise(setNoteKindProgram(me, id, 'note'))
    expect(await edges()).toEqual(edgesBefore)
    expect(await filings()).toEqual(filingsBefore)
    expect(await body()).toEqual(bodyBefore)
  })
})

describe('scratch', () => {
  it('is one of the three kinds the column holds, and the only three', async () => {
    const { NOTE_KINDS } = await import('./kind')
    const { noteKind } = await import('@spaces/db/schema/kinds')
    // The validator, the segmented control and the enum are one list. A
    // fourth kind is a taxonomy leaking into structure (CONTEXT.md).
    expect([...NOTE_KINDS].sort()).toEqual([...noteKind.enumValues].sort())
    expect(NOTE_KINDS).toHaveLength(3)
  })

  it('suppresses nothing: it lists, files, searches and reaches the assembler as a note', async () => {
    const { setNoteKindProgram } = await import('./kind')
    const { listNoteRows } = await import('#/lib/server/notes')
    const { getSpaceProgram } = await import('#/lib/server/spaces')
    const { assembleProgram } = await import('#/lib/context/assemble')
    const { db } = await import('@spaces/db')
    const { entity, entitySpace, link, space } =
      await import('@spaces/db/schema')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    // Born a scratch note. `note.tsv` is generated by Postgres from title +
    // body_md, so the search row below exists without anyone writing it., the way `createNote` writes one now that its
    // validator carries all three kinds.
    const id = await makeNote({
      tag,
      authorId: me,
      kind: 'scratch',
      bodyMd: `The ${BODY_WORD} is the whole thesis.`,
    })
    const [co] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `ScratchCo ${tag}` })
      .returning({ id: entity.id })
    const [spaceEnt] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `ScratchSpace ${tag}` })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: spaceEnt.id,
      slug: `scratch_${tag}`,
      path: `s_${tag}`,
    })
    await db
      .insert(entitySpace)
      .values({ entityId: id, spaceId: spaceEnt.id, source: 'manual' })
    await db.insert(link).values({
      fromEntityId: id,
      toEntityId: co.id,
      relation: 'tagged_in',
      source: 'manual',
    })

    // 1. The notes ledger lists it, with its kind, like any other note.
    const listed = (await listNoteRows(me)).find((r) => r.id === id)
    expect(listed?.kind).toBe('scratch')

    // 2. The space's Filed lane carries it, with its kind.
    const space1 = await Effect.runPromise(getSpaceProgram(spaceEnt.id, me))
    expect(
      space1.filed.map((f) => ({ id: f.id, kind: f.kind })),
    ).toContainEqual({ id, kind: 'scratch' })

    // 3. Cmd-K finds it.
    expect(await noteHits(BODY_WORD)).toContain(id)

    // 4. The assembler reaches it as `ContextKind 'note'` — only `memo` is
    //    its own kind, and scratch is not a third citation class.
    const assembled = await Effect.runPromise(
      assembleProgram(
        { entityId: co.id },
        {
          user: { id: me },
          asOf: '2026-09-20T00:00:00Z',
          budgetChars: 8000,
        },
      ),
    )
    const item = assembled.items.find((x) => x.ref === `note:${id}`)
    expect(item?.kind).toBe('note')

    // 5. And it round-trips: promote, demote, still every one of the above.
    await Effect.runPromise(setNoteKindProgram(me, id, 'memo'))
    await Effect.runPromise(setNoteKindProgram(me, id, 'scratch'))
    expect(await kindOf(id)).toBe('scratch')
    expect((await listNoteRows(me)).find((r) => r.id === id)?.kind).toBe(
      'scratch',
    )
    const space2 = await Effect.runPromise(getSpaceProgram(spaceEnt.id, me))
    expect(space2.filed.map((f) => f.id)).toContain(id)
    expect(await noteHits(BODY_WORD)).toContain(id)
  })
})
