import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Manual interaction logging and its write-up (SPA-123).
 *
 * The two paths the dialog's two footer buttons take: "Log meeting", which
 * leaves `note_id` null and writes no note at all, and "Log and write up",
 * which births the body note, files it against every attendee and claims it.
 * The third test is the database's half of the contract — one body, one
 * interaction — and the fourth is what the record page reads.
 *
 * Imports are dynamic like the rest of the DB-coupled suite: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time and `vitest.setup.ts`
 * rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** A live company to have met with. */
async function aCompany(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/** A live person to have been in the room. */
async function aPerson(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, person } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'person', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(person).values({ entityId: ent.id })
  return ent.id
}

/**
 * The database's refusal, message and cause — drizzle wraps the driver error,
 * so the constraint name lives one level down. Same shape as
 * `source-class.test.ts`'s helper.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    if (!(err instanceof Error)) return String(err)
    return `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}`
  }
  throw new Error('The write was accepted; it should have been refused')
}

/** Every edge the note has, as `relation:source:target` triples. */
async function edgesFrom(noteId: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db
    .select({
      relation: link.relation,
      source: link.source,
      to: link.toEntityId,
    })
    .from(link)
    .where(eq(link.fromEntityId, noteId))
  return rows.map((r) => `${r.relation}:${r.source}:${r.to}`).sort()
}

describe('logInteractionProgram', () => {
  it('writes the interaction, one note filed against every attendee, and nothing else', async () => {
    const { logInteractionProgram } = await import('./log')
    const { db } = await import('@spaces/db')
    const { entity, interaction, note } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(`Kestrel ${tag}`)
    const founderId = await aPerson(`Ada ${tag}`)

    const { id, noteId } = await Effect.runPromise(
      logInteractionProgram(author, {
        kind: 'meeting',
        subject: `Series B intro ${tag}`,
        occurredAt: new Date('2026-09-18T10:00:00Z'),
        attendeeIds: [companyId, founderId],
        writeUp: true,
      }),
    )
    expect(noteId).toBeTruthy()
    if (!noteId) throw new Error('no note')

    // The interaction points at its body.
    const row = (
      await db
        .select({ noteId: interaction.noteId, subject: interaction.subject })
        .from(interaction)
        .where(eq(interaction.id, id))
    ).at(0)
    expect(row?.noteId).toBe(noteId)

    // Exactly one note carries this subject, and it is an ordinary one.
    const notes = await db
      .select({
        id: note.entityId,
        title: note.title,
        kind: note.kind,
        visibility: note.visibility,
        authorId: note.authorId,
        bodyMd: note.bodyMd,
      })
      .from(note)
      .where(eq(note.title, `Series B intro ${tag}`))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      id: noteId,
      title: `Series B intro ${tag}`,
      kind: 'note',
      visibility: 'shared',
      authorId: author,
      // No starter mention block: the attendees are filed, not mentioned.
      bodyMd: '',
    })

    // Named the same on the entity row, so search and mentions find it.
    const ent = (
      await db
        .select({ name: entity.canonicalName })
        .from(entity)
        .where(eq(entity.id, noteId))
    ).at(0)
    expect(ent?.name).toBe(`Series B intro ${tag}`)

    // One filing per attendee, and not one other edge.
    expect(await edgesFrom(noteId)).toEqual(
      [`tagged_in:manual:${companyId}`, `tagged_in:manual:${founderId}`].sort(),
    )

    // A note.created activity row beside the interaction.meeting one.
    const verbs = await db
      .select({ verb: activity.verb })
      .from(activity)
      .where(
        and(
          eq(activity.actorId, author),
          eq(activity.subjectEntityId, companyId),
        ),
      )
    expect(verbs.map((v) => v.verb).sort()).toEqual([
      'interaction.meeting',
      'note.created',
    ])
  })

  it('leaves note_id null and creates no note when the write-up is not asked for', async () => {
    const { logInteractionProgram } = await import('./log')
    const { db } = await import('@spaces/db')
    const { interaction, link, note } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(`Marlin ${tag}`)

    const { id, noteId } = await Effect.runPromise(
      logInteractionProgram(await actorId(), {
        kind: 'call',
        subject: `Quick call ${tag}`,
        occurredAt: new Date('2026-09-18T11:00:00Z'),
        attendeeIds: [companyId],
        writeUp: false,
      }),
    )
    expect(noteId).toBeNull()

    const row = (
      await db
        .select({ noteId: interaction.noteId })
        .from(interaction)
        .where(eq(interaction.id, id))
    ).at(0)
    expect(row?.noteId).toBeNull()
    // Not "no notes at all" — the file's earlier test wrote one — but no note
    // for this call: the plain path manufactures nothing.
    expect(
      await db
        .select()
        .from(note)
        .where(eq(note.title, `Quick call ${tag}`)),
    ).toHaveLength(0)
    expect(
      await db.select().from(link).where(eq(link.toEntityId, companyId)),
    ).toHaveLength(0)
  })

  it('refuses a second interaction pointing at the same note', async () => {
    const { logInteractionProgram } = await import('./log')
    const { db } = await import('@spaces/db')
    const { interaction } = await import('@spaces/db/schema')

    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(`Osprey ${tag}`)

    const { noteId } = await Effect.runPromise(
      logInteractionProgram(await actorId(), {
        kind: 'meeting',
        subject: `Board ${tag}`,
        occurredAt: new Date('2026-09-18T12:00:00Z'),
        attendeeIds: [companyId],
        writeUp: true,
      }),
    )

    // A second interaction claiming the same body is a database error, not a
    // race the write path has to be careful about.
    const refusal = await refusalOf(() =>
      db.insert(interaction).values({
        kind: 'call',
        sourceClass: 'manual',
        subject: `Stolen body ${tag}`,
        occurredAt: new Date('2026-09-18T13:00:00Z'),
        noteId,
      }),
    )
    expect(refusal).toMatch(/interaction_note_unique/)

    // And a NULL is not a claim: any number of bodyless rows are legal.
    await db.insert(interaction).values([
      {
        kind: 'call',
        sourceClass: 'manual',
        subject: `Bodyless a ${tag}`,
        occurredAt: new Date('2026-09-18T14:00:00Z'),
      },
      {
        kind: 'call',
        sourceClass: 'manual',
        subject: `Bodyless b ${tag}`,
        occurredAt: new Date('2026-09-18T15:00:00Z'),
      },
    ])
  })

  it('puts the write-up under "Filed here" on every attendee, and links the timeline row to it', async () => {
    const { logInteractionProgram } = await import('./log')
    const { listRecordNotesProgram } = await import('#/lib/notes/list-record')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(`Harrier ${tag}`)
    const founderId = await aPerson(`Grace ${tag}`)

    const { id, noteId } = await Effect.runPromise(
      logInteractionProgram(author, {
        kind: 'meeting',
        subject: `Diligence sync ${tag}`,
        occurredAt: new Date('2026-09-18T16:00:00Z'),
        attendeeIds: [companyId, founderId],
        writeUp: true,
      }),
    )

    for (const recordId of [companyId, founderId]) {
      const lanes = await Effect.runPromise(
        listRecordNotesProgram(author, recordId),
      )
      expect(lanes.filed.map((f) => f.id)).toEqual([noteId])
      expect(lanes.filed[0].title).toBe(`Diligence sync ${tag}`)
      expect(lanes.mentions).toEqual([])
    }

    // The ledger row carries the id the link treatment needs.
    const items = await Effect.runPromise(recordTimelineProgram(companyId))
    const logged = items.find((i) => i.type === 'interaction' && i.id === id)
    expect(logged).toMatchObject({ noteId })
  })

  it('leaves the timeline row noteId null for a plain log', async () => {
    const { logInteractionProgram } = await import('./log')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')

    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(`Petrel ${tag}`)
    const { id } = await Effect.runPromise(
      logInteractionProgram(await actorId(), {
        kind: 'call',
        subject: `Catch-up ${tag}`,
        occurredAt: new Date('2026-09-18T17:00:00Z'),
        attendeeIds: [companyId],
        writeUp: false,
      }),
    )

    const items = await Effect.runPromise(recordTimelineProgram(companyId))
    const logged = items.find((i) => i.type === 'interaction' && i.id === id)
    expect(logged).toMatchObject({ noteId: null })
  })
})

describe('deleting a write-up', () => {
  it('orphans the interaction rather than taking the meeting with it', async () => {
    const { logInteractionProgram } = await import('./log')
    const { deleteEntityProgram } = await import('#/lib/entities/delete')
    const { db } = await import('@spaces/db')
    const { interaction } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(`Fulmar ${tag}`)
    const { id, noteId } = await Effect.runPromise(
      logInteractionProgram(await actorId(), {
        kind: 'meeting',
        subject: `Kickoff ${tag}`,
        occurredAt: new Date('2026-09-18T18:00:00Z'),
        attendeeIds: [companyId],
        writeUp: true,
      }),
    )
    if (!noteId) throw new Error('no note')

    // `del: { kind: 'orphan' }` — the prose goes, the event stays.
    expect(await Effect.runPromise(deleteEntityProgram(noteId))).toEqual({
      deleted: true,
    })
    const row = (
      await db
        .select({ noteId: interaction.noteId, subject: interaction.subject })
        .from(interaction)
        .where(eq(interaction.id, id))
    ).at(0)
    expect(row).toMatchObject({ noteId: null, subject: `Kickoff ${tag}` })
  })
})
