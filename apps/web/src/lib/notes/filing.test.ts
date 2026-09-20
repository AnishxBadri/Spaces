import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Filing a note against a record (SPA-116), against the test database.
 *
 * Three things are pinned here. The first is the stamp: the editor's chip
 * writes the same `link(tagged_in, manual)` row `createNoteProgram` writes
 * at birth, so a note filed from the editor and a note filed by "Note about
 * this" are one row shape, not two.
 *
 * The second is the load-bearing one — **unfiling removes the filing and
 * nothing else.** A `mentions` edge to the same record is a different row in
 * the edge table, and after the × it is still there, which is what moves the
 * note from "Filed here" to "Mentions this" on that record rather than off
 * its page.
 *
 * The third is that the allowlist lives on the server. The picker never
 * offers a space, a note, a document, a term, a merged record or the note
 * itself; every one of those is asked of the program directly here, because
 * a client filter is a convenience and never a rule.
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

async function makeNote(tag: string, authorId: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, note } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({
      kind: 'note',
      canonicalName: `Filing ${tag}`,
      createdBy: authorId,
    })
    .returning({ id: entity.id })
  await db
    .insert(note)
    .values({ entityId: ent.id, title: `Filing ${tag}`, authorId })
  return ent.id
}

/**
 * One entity of any kind. `readTarget` reads the `entity` row alone — kind,
 * name and `merged_into_id` — so the side tables are beside the point for
 * every refusal below, and a company gets its `company` row because the
 * happy path is a real record.
 */
async function makeEntity(
  kind: 'company' | 'person' | 'deal' | 'space' | 'document' | 'term',
  name: string,
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind, canonicalName: name })
    .returning({ id: entity.id })
  if (kind === 'company') await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/** Every edge out of the note, as `relation:source:target`. */
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

/** The filing verbs written about one record, oldest first. */
async function filingActivity(
  recordId: string,
): Promise<Array<{ verb: string; object: string | null }>> {
  const { db } = await import('@spaces/db')
  const { activity } = await import('@spaces/db/schema/activity')
  const { asc, eq } = await import('drizzle-orm')
  const rows = await db
    .select({ verb: activity.verb, object: activity.objectEntityId })
    .from(activity)
    .where(eq(activity.subjectEntityId, recordId))
    .orderBy(asc(activity.at))
  return rows.map((r) => ({ verb: r.verb, object: r.object }))
}

describe('fileNoteAgainstProgram', () => {
  it('writes link(tagged_in, manual) and one activity row naming both', async () => {
    const { fileNoteAgainstProgram } = await import('./filing')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)
    const companyId = await makeEntity('company', `Kestrel ${tag}`)

    expect(
      await Effect.runPromise(fileNoteAgainstProgram(me, noteId, companyId)),
    ).toEqual({ filed: true })

    // The same stamp `createNoteProgram` writes at birth — one row shape.
    expect(await edgesFrom(noteId)).toEqual([`tagged_in:manual:${companyId}`])
    // Subject the record, object the note: both named, and it lands on the
    // record's timeline where `note.created` already lands.
    expect(await filingActivity(companyId)).toEqual([
      { verb: 'note.filed', object: noteId },
    ])
  })

  it('is idempotent — a second click is the same outcome and no second activity row', async () => {
    const { fileNoteAgainstProgram } = await import('./filing')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)
    const dealId = await makeEntity('deal', `Kestrel Seed ${tag}`)

    await Effect.runPromise(fileNoteAgainstProgram(me, noteId, dealId))
    expect(
      await Effect.runPromise(fileNoteAgainstProgram(me, noteId, dealId)),
    ).toEqual({ filed: false })

    expect(await edgesFrom(noteId)).toEqual([`tagged_in:manual:${dealId}`])
    expect(await filingActivity(dealId)).toHaveLength(1)
  })

  it('files against a person the same way — the kind is not the mechanism', async () => {
    const { fileNoteAgainstProgram } = await import('./filing')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)
    const personId = await makeEntity('person', `Ada ${tag}`)

    await Effect.runPromise(fileNoteAgainstProgram(me, noteId, personId))
    expect(await edgesFrom(noteId)).toEqual([`tagged_in:manual:${personId}`])
  })

  it('files against a custom record, and the chip can route through its object slug', async () => {
    const { fileNoteAgainstProgram } = await import('./filing')
    const { db } = await import('@spaces/db')
    const { entity, link, objectDef } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const { recordPath } = await import('#/lib/record-path')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)
    const [obj] = await db
      .insert(objectDef)
      .values({ slug: `funds_${tag}`, singular: 'Fund', plural: 'Funds' })
      .returning({ id: objectDef.id, slug: objectDef.slug })
    const [record] = await db
      .insert(entity)
      .values({
        kind: 'custom',
        objectId: obj.id,
        canonicalName: `Vector II ${tag}`,
      })
      .returning({ id: entity.id })

    await Effect.runPromise(fileNoteAgainstProgram(me, noteId, record.id))

    // `getNote`'s outbound read, in miniature: the slug rides along so the
    // chip routes to `/o/<slug>/<id>` rather than nowhere.
    const [chip] = await db
      .select({
        id: entity.id,
        kind: entity.kind,
        objectSlug: objectDef.slug,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(and(eq(link.fromEntityId, noteId), eq(link.relation, 'tagged_in')))
    expect(recordPath(chip)).toBe(`/o/funds_${tag}/${record.id}`)
  })

  it('answers "Note not found" for a note that is not there', async () => {
    const { fileNoteAgainstProgram, noteFilingMessage } =
      await import('./filing')
    const { NoteNotFound } = await import('./delete')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const companyId = await makeEntity('company', `Kestrel ${tag}`)

    const failure = await Effect.runPromise(
      Effect.flip(fileNoteAgainstProgram(me, randomUUID(), companyId)),
    )
    expect(failure).toBeInstanceOf(NoteNotFound)
    expect(noteFilingMessage(failure)).toBe('Note not found')
  })
})

describe('unfileNoteFromProgram', () => {
  it('removes only the tagged_in row — an existing mention survives', async () => {
    const { fileNoteAgainstProgram, unfileNoteFromProgram } =
      await import('./filing')
    const { db } = await import('@spaces/db')
    const { link } = await import('@spaces/db/schema')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)
    const companyId = await makeEntity('company', `Kestrel ${tag}`)

    // The body names the company, which is what `saveNote`'s diff-sync
    // materializes — `mentions`/`extracted`, the stamp it owns.
    await db.insert(link).values({
      fromEntityId: noteId,
      toEntityId: companyId,
      relation: 'mentions',
      source: 'extracted',
      createdBy: me,
    })
    await Effect.runPromise(fileNoteAgainstProgram(me, noteId, companyId))
    expect(await edgesFrom(noteId)).toEqual([
      `mentions:extracted:${companyId}`,
      `tagged_in:manual:${companyId}`,
    ])

    expect(
      await Effect.runPromise(unfileNoteFromProgram(me, noteId, companyId)),
    ).toEqual({ unfiled: true })

    // The filing goes; the reference stays. This is the whole point: the
    // note moves to "Mentions this" on that record, it does not leave it.
    expect(await edgesFrom(noteId)).toEqual([`mentions:extracted:${companyId}`])

    // And the record's two lanes agree with the edge table.
    const { listRecordNotesProgram } = await import('./list-record')
    const lanes = await Effect.runPromise(listRecordNotesProgram(me, companyId))
    expect(lanes.filed).toHaveLength(0)
    expect(lanes.mentions.map((n) => n.id)).toEqual([noteId])

    expect((await filingActivity(companyId)).map((a) => a.verb)).toEqual([
      'note.filed',
      'note.unfiled',
    ])
  })

  it('is idempotent — nothing to remove is not an error and writes no activity', async () => {
    const { unfileNoteFromProgram } = await import('./filing')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)
    const companyId = await makeEntity('company', `Kestrel ${tag}`)

    expect(
      await Effect.runPromise(unfileNoteFromProgram(me, noteId, companyId)),
    ).toEqual({ unfiled: false })
    expect(await filingActivity(companyId)).toHaveLength(0)
  })
})

describe('the target allowlist is the server’s', () => {
  it('refuses every kind the picker does not offer, each in its own words', async () => {
    const { fileNoteAgainstProgram, FilingTargetRejected, noteFilingMessage } =
      await import('./filing')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)

    const refusals: Array<[string, string]> = []
    for (const kind of ['space', 'document', 'term'] as const) {
      const targetId = await makeEntity(kind, `${kind} ${tag}`)
      const failure = await Effect.runPromise(
        Effect.flip(fileNoteAgainstProgram(me, noteId, targetId)),
      )
      expect(failure).toBeInstanceOf(FilingTargetRejected)
      refusals.push([kind, noteFilingMessage(failure)])
    }

    // A note is a kind too, and it is refused as one rather than by id.
    const otherNote = await makeNote(`${tag}-other`, me)
    const noteFailure = await Effect.runPromise(
      Effect.flip(fileNoteAgainstProgram(me, noteId, otherNote)),
    )
    expect(noteFailure).toBeInstanceOf(FilingTargetRejected)
    refusals.push(['note', noteFilingMessage(noteFailure)])

    expect(refusals).toEqual([
      ['space', 'A space is filed into, not against — use “Filed in space”.'],
      ['document', 'A document is filed against a record, not against a note.'],
      [
        'term',
        'A note is filed against a company, person, deal or custom record — not a term.',
      ],
      ['note', 'A note is not filed against another note; mention it instead.'],
    ])

    // Not one edge was written by any of it.
    expect(await edgesFrom(noteId)).toEqual([])
  })

  it('refuses the note itself, and a target that is gone', async () => {
    const { fileNoteAgainstProgram, FilingTargetRejected, noteFilingMessage } =
      await import('./filing')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)

    const itself = await Effect.runPromise(
      Effect.flip(fileNoteAgainstProgram(me, noteId, noteId)),
    )
    expect(itself).toBeInstanceOf(FilingTargetRejected)
    expect(noteFilingMessage(itself)).toBe(
      'A note cannot be filed against itself.',
    )

    const gone = await Effect.runPromise(
      Effect.flip(fileNoteAgainstProgram(me, noteId, randomUUID())),
    )
    expect(noteFilingMessage(gone)).toBe('That record no longer exists.')

    expect(await edgesFrom(noteId)).toEqual([])
  })

  it('refuses a record that was merged away — the chip would name a tombstone', async () => {
    const { fileNoteAgainstProgram, FilingTargetRejected, noteFilingMessage } =
      await import('./filing')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const noteId = await makeNote(tag, me)
    const survivor = await makeEntity('company', `Kestrel ${tag}`)
    const dupe = await makeEntity('company', `Kestrel Ltd ${tag}`)
    await db
      .update(entity)
      .set({ mergedIntoId: survivor })
      .where(eq(entity.id, dupe))

    const failure = await Effect.runPromise(
      Effect.flip(fileNoteAgainstProgram(me, noteId, dupe)),
    )
    expect(failure).toBeInstanceOf(FilingTargetRejected)
    expect(noteFilingMessage(failure)).toBe(
      `“Kestrel Ltd ${tag}” was merged into another record — file the note against that one.`,
    )

    // The survivor takes it, which is what the message tells the user to do.
    expect(
      await Effect.runPromise(fileNoteAgainstProgram(me, noteId, survivor)),
    ).toEqual({ filed: true })
  })
})
