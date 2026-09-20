import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Writing up an interaction that was logged without a body (SPA-128).
 *
 * The four things the program claims: it fills `note_id` with an ordinary
 * note titled from the subject, it names a kind-and-date title when the
 * subject is null, it is idempotent, and two concurrent calls agree on one
 * body and leave exactly one note row behind.
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
 * A bodyless interaction — the shape everything logged before SPA-123 and
 * everything a calendar will sync is in. Written straight to the tables
 * rather than through `logInteractionProgram` so that `subject` can be null,
 * which the dialog's validator forbids and a synced row does not.
 */
async function anInteraction(input: {
  kind: 'email' | 'meeting' | 'call'
  subject: string | null
  occurredAt: Date
  attendeeIds: Array<string>
}): Promise<string> {
  const { db } = await import('@spaces/db')
  const { interaction, interactionEntity } = await import('@spaces/db/schema')
  const [row] = await db
    .insert(interaction)
    .values({
      kind: input.kind,
      sourceClass: 'manual',
      subject: input.subject,
      occurredAt: input.occurredAt,
    })
    .returning({ id: interaction.id })
  for (const entityId of input.attendeeIds) {
    await db
      .insert(interactionEntity)
      .values({ interactionId: row.id, entityId })
  }
  return row.id
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

describe('writeUpTitle', () => {
  it('names the subject when there is one and the kind and date when there is not', async () => {
    const { writeUpTitle } = await import('./write-up')
    const { stamp } = await import('#/lib/timeline/stamp')
    const at = new Date('2026-09-18T10:00:00Z')

    expect(writeUpTitle('meeting', 'Series B intro', at)).toBe('Series B intro')
    // Whitespace is not a name.
    expect(writeUpTitle('call', '   ', at)).toBe(
      `Call · ${stamp(at.toISOString())}`,
    )
    expect(writeUpTitle('email', null, at)).toBe(
      `Email · ${stamp(at.toISOString())}`,
    )
  })
})

describe('writeUpInteractionProgram', () => {
  it('fills note_id with an ordinary note titled from the subject and filed against every attendee', async () => {
    const { writeUpInteractionProgram } = await import('./write-up')
    const { db } = await import('@spaces/db')
    const { entity, interaction, note } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(`Kestrel ${tag}`)
    const founderId = await aPerson(`Ada ${tag}`)
    // A third record that was *not* in the room: the filing must not reach it.
    const bystanderId = await aCompany(`Bystander ${tag}`)

    const id = await anInteraction({
      kind: 'call',
      subject: `Founder call ${tag}`,
      occurredAt: new Date('2026-09-18T10:00:00Z'),
      attendeeIds: [companyId, founderId],
    })

    const { noteId } = await Effect.runPromise(
      writeUpInteractionProgram(author, id),
    )
    expect(noteId).toBeTruthy()

    const row = (
      await db
        .select({ noteId: interaction.noteId })
        .from(interaction)
        .where(eq(interaction.id, id))
    ).at(0)
    expect(row?.noteId).toBe(noteId)

    // A plain note: kind `note`, visibility `shared`, the caller as author,
    // and no starter mention block.
    const body = (
      await db
        .select({
          title: note.title,
          kind: note.kind,
          visibility: note.visibility,
          authorId: note.authorId,
          bodyMd: note.bodyMd,
        })
        .from(note)
        .where(eq(note.entityId, noteId))
    ).at(0)
    expect(body).toMatchObject({
      title: `Founder call ${tag}`,
      kind: 'note',
      visibility: 'shared',
      authorId: author,
      bodyMd: '',
    })

    const ent = (
      await db
        .select({ name: entity.canonicalName })
        .from(entity)
        .where(eq(entity.id, noteId))
    ).at(0)
    expect(ent?.name).toBe(`Founder call ${tag}`)

    // Exactly the attendee set, and not one edge more.
    expect(await edgesFrom(noteId)).toEqual(
      [`tagged_in:manual:${companyId}`, `tagged_in:manual:${founderId}`].sort(),
    )
    expect(await edgesFrom(noteId)).not.toContain(
      `tagged_in:manual:${bystanderId}`,
    )
  })

  it('titles a subjectless interaction by its kind and date', async () => {
    const { writeUpInteractionProgram, writeUpTitle } =
      await import('./write-up')
    const { db } = await import('@spaces/db')
    const { note } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(`Marlin ${tag}`)
    const occurredAt = new Date('2026-09-17T09:30:00Z')
    const id = await anInteraction({
      kind: 'meeting',
      subject: null,
      occurredAt,
      attendeeIds: [companyId],
    })

    const { noteId } = await Effect.runPromise(
      writeUpInteractionProgram(await actorId(), id),
    )
    const body = (
      await db
        .select({ title: note.title })
        .from(note)
        .where(eq(note.entityId, noteId))
    ).at(0)
    expect(body?.title).toBe(writeUpTitle('meeting', null, occurredAt))
    expect(body?.title).toMatch(/^Meeting · \d\d-\d\d \d\d:\d\d$/)
  })

  it('hands back the existing body rather than forking a second one', async () => {
    const { writeUpInteractionProgram } = await import('./write-up')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(`Osprey ${tag}`)
    const id = await anInteraction({
      kind: 'meeting',
      subject: `Board ${tag}`,
      occurredAt: new Date('2026-09-18T12:00:00Z'),
      attendeeIds: [companyId],
    })

    const first = await Effect.runPromise(writeUpInteractionProgram(author, id))
    const second = await Effect.runPromise(
      writeUpInteractionProgram(author, id),
    )
    expect(second.noteId).toBe(first.noteId)

    const notes = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.canonicalName, `Board ${tag}`))
    expect(notes).toHaveLength(1)
  })

  it('agrees on one body when two calls race, and leaves no losing note behind', async () => {
    const { writeUpInteractionProgram } = await import('./write-up')
    const { db } = await import('@spaces/db')
    const { entity, interaction, link } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(`Harrier ${tag}`)
    const id = await anInteraction({
      kind: 'call',
      subject: `Raced ${tag}`,
      occurredAt: new Date('2026-09-18T16:00:00Z'),
      attendeeIds: [companyId],
    })

    // Both in flight before either claims: each births a body, exactly one
    // claim can land, and the loser re-reads the winner and takes its own
    // body with it.
    const [a, b] = await Promise.all([
      Effect.runPromise(writeUpInteractionProgram(author, id)),
      Effect.runPromise(writeUpInteractionProgram(author, id)),
    ])
    expect(a.noteId).toBe(b.noteId)

    const row = (
      await db
        .select({ noteId: interaction.noteId })
        .from(interaction)
        .where(eq(interaction.id, id))
    ).at(0)
    expect(row?.noteId).toBe(a.noteId)

    // One note row, not two — the losing body is gone, edges included.
    const notes = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.canonicalName, `Raced ${tag}`))
    expect(notes.map((n) => n.id)).toEqual([a.noteId])

    const filings = await db
      .select({ from: link.fromEntityId })
      .from(link)
      .where(eq(link.toEntityId, companyId))
    expect(filings.map((f) => f.from)).toEqual([a.noteId])
  })

  it('refuses an interaction that is not there', async () => {
    const { writeUpInteractionProgram, writeUpMessage } =
      await import('./write-up')
    const missing = randomUUID()
    await expect(
      Effect.runPromise(writeUpInteractionProgram(await actorId(), missing)),
    ).rejects.toMatchObject({ _tag: 'InteractionNotFound' })
    expect(writeUpMessage({ _tag: 'nope' })).toBe('Could not write it up')
  })

  it('turns the timeline row from a write-up affordance into an open-note one', async () => {
    const { writeUpInteractionProgram } = await import('./write-up')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')

    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(`Petrel ${tag}`)
    const id = await anInteraction({
      kind: 'call',
      subject: `Catch-up ${tag}`,
      occurredAt: new Date('2026-09-18T17:00:00Z'),
      attendeeIds: [companyId],
    })

    const before = (
      await Effect.runPromise(recordTimelineProgram(companyId))
    ).find((i) => i.type === 'interaction' && i.id === id)
    expect(before).toMatchObject({ noteId: null })

    const { noteId } = await Effect.runPromise(
      writeUpInteractionProgram(await actorId(), id),
    )
    const after = (
      await Effect.runPromise(recordTimelineProgram(companyId))
    ).find((i) => i.type === 'interaction' && i.id === id)
    expect(after).toMatchObject({ noteId })
  })

  it('puts the write-up under "Filed here" on the attendee', async () => {
    const { writeUpInteractionProgram } = await import('./write-up')
    const { listRecordNotesProgram } = await import('#/lib/notes/list-record')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(`Fulmar ${tag}`)
    const founderId = await aPerson(`Grace ${tag}`)
    const id = await anInteraction({
      kind: 'meeting',
      subject: `Diligence sync ${tag}`,
      occurredAt: new Date('2026-09-18T18:00:00Z'),
      attendeeIds: [companyId, founderId],
    })

    const { noteId } = await Effect.runPromise(
      writeUpInteractionProgram(author, id),
    )
    for (const recordId of [companyId, founderId]) {
      const lanes = await Effect.runPromise(
        listRecordNotesProgram(author, recordId),
      )
      expect(lanes.filed.map((f) => f.id)).toEqual([noteId])
      expect(lanes.mentions).toEqual([])
    }
  })
})
