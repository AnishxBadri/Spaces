import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, interaction, note } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { listNoteRows } from './list-rows'

/**
 * The Notes index lists what a person wrote or filed as a note. An email's
 * body sits in a note row too, and stays off the list; a meeting's write-up
 * is a note and stays on it.
 */

async function aNote(title: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: title })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no entity')
  await db.insert(note).values({
    entityId: row.id,
    title,
    authorId: FIXTURE_ACTOR.id,
    visibility: 'private',
    bodyMd: 'Body.',
  })
  return row.id
}

const carriedBy = (kind: 'email' | 'meeting', noteId: string) =>
  db.insert(interaction).values({
    kind,
    subject: 'Carrier',
    occurredAt: new Date('2026-10-15T09:00:00.000Z'),
    noteId,
  })

describe('the Notes index rows', () => {
  it("leaves out an email's body and keeps a meeting's write-up and a plain note", async () => {
    const mail = await aNote('Re: Proposal')
    const writeUp = await aNote('Founder call')
    const plain = await aNote('Diligence thoughts')
    await carriedBy('email', mail)
    await carriedBy('meeting', writeUp)
    const listed = (await listNoteRows(FIXTURE_ACTOR.id)).map((r) => r.id)
    expect(listed).toContain(writeUp)
    expect(listed).toContain(plain)
    expect(listed).not.toContain(mail)
  })
})
