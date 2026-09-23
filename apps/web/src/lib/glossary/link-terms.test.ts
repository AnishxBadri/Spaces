import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Glossary terms as concept nodes (SPA-34), against the test database.
 *
 * The note half runs through `saveNoteProgram` — the body of the `saveNote`
 * server fn — so what is pinned is the save a person makes, not a helper
 * beside it. The document half's standalone form is here too; the
 * extraction job's own run is `worker/jobs/extract-document.terms.test.ts`
 * (nothing under `lib/` may import the worker).
 *
 * Imports are dynamic like the rest of the DB-coupled suite: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time and `vitest.setup.ts`
 * rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

const label = () => `s${randomUUID().replace(/-/g, '').slice(0, 12)}`

/** A space under `parent` (or a root), with a real ltree path. */
async function makeSpace(
  name: string,
  parent: { id: string; path: string } | null,
): Promise<{ id: string; path: string }> {
  const { db } = await import('@spaces/db')
  const { entity, space } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'space', canonicalName: name })
    .returning({ id: entity.id })
  const own = label()
  const path = parent ? `${parent.path}.${own}` : own
  await db.insert(space).values({
    entityId: ent.id,
    parentId: parent?.id ?? null,
    slug: own,
    path,
  })
  return { id: ent.id, path }
}

/**
 * A term whose name (and every alias) carries a random letter suffix.
 * Isolation is per file, not per test, so the terms an earlier case made
 * are still in scope here — a suffixed word matches only its own term.
 */
async function makeTerm(
  base: string,
  spaceId: string | null,
  aliasBases: Array<string> = [],
): Promise<{ id: string; name: string; aliases: Array<string> }> {
  // Hex digits spelled as letters, so the suffix stays inside the word.
  const suffix = randomUUID()
    .replace(/-/g, '')
    .slice(0, 8)
    .replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])
    .toUpperCase()
  const name = `${base}${suffix}`
  const aliases = aliasBases.map((a) => `${a} ${suffix}`)
  const { db } = await import('@spaces/db')
  const { entity, term } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'term', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(term).values({ entityId: ent.id, name, aliases, spaceId })
  return { id: ent.id, name, aliases }
}

async function makeNote(spaceIds: Array<string>): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, entitySpace, note } = await import('@spaces/db/schema')
  const author = await actorId()
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: 'Glossary note', createdBy: author })
    .returning({ id: entity.id })
  await db
    .insert(note)
    .values({ entityId: ent.id, title: 'Glossary note', authorId: author })
  for (const spaceId of spaceIds)
    await db.insert(entitySpace).values({ entityId: ent.id, spaceId })
  return ent.id
}

async function makeCompany(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function save(
  noteId: string,
  bodyMd: string,
  mentionIds: Array<string> = [],
) {
  const { saveNoteProgram } = await import('#/lib/notes/save')
  return Effect.runPromise(
    saveNoteProgram(await actorId(), {
      id: noteId,
      title: 'Glossary note',
      body: { bodyJson: [], bodyMd, mentionIds },
    }),
  )
}

type Edge = {
  id: string
  to: string
  source: string
  createdAt: Date
}

/** Every `mentions` edge out of `fromId`. */
async function mentionsFrom(fromId: string): Promise<Array<Edge>> {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  return db
    .select({
      id: link.id,
      to: link.toEntityId,
      source: link.source,
      createdAt: link.createdAt,
    })
    .from(link)
    .where(and(eq(link.fromEntityId, fromId), eq(link.relation, 'mentions')))
}

describe('a note save links the terms its body mentions', () => {
  it('writes exactly one extracted link for a term said three times', async () => {
    const pue = await makeTerm('PUE', null)
    const noteId = await makeNote([])

    await save(
      noteId,
      `${pue.name} is 1.1. Target ${pue.name} 1.05; the ${pue.name} story holds.`,
    )

    const edges = await mentionsFrom(noteId)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ to: pue.id, source: 'extracted' })
  })

  it('reaches a term through an alias', async () => {
    const pue = await makeTerm('PUE', null, ['power usage effectiveness'])
    const noteId = await makeNote([])

    await save(noteId, `The ${pue.aliases[0].toUpperCase()} came in at 1.2.`)

    expect((await mentionsFrom(noteId)).map((e) => e.to)).toEqual([pue.id])
  })

  it('deletes the extracted link once the word is gone', async () => {
    const pue = await makeTerm('PUE', null)
    const noteId = await makeNote([])

    await save(noteId, `${pue.name} matters.`)
    expect((await mentionsFrom(noteId)).map((e) => e.to)).toEqual([pue.id])

    const second = await save(noteId, 'Nothing about cooling here.')
    expect(second.mentions).toEqual({ added: [], removed: [pue.id] })
    expect(await mentionsFrom(noteId)).toEqual([])
  })

  it('never deletes or duplicates a manual link on the same pair', async () => {
    const { db } = await import('@spaces/db')
    const { link } = await import('@spaces/db/schema')
    const pue = await makeTerm('PUE', null)
    const noteId = await makeNote([])
    const [manual] = await db
      .insert(link)
      .values({
        fromEntityId: noteId,
        toEntityId: pue.id,
        relation: 'mentions',
        source: 'manual',
      })
      .returning({ id: link.id })

    // The word present: the manual row already carries the edge, so no
    // extracted row is written beside it.
    const withWord = await save(noteId, `${pue.name}, ${pue.name}.`)
    expect(withWord.mentions).toEqual({ added: [], removed: [] })
    expect(await mentionsFrom(noteId)).toEqual([
      expect.objectContaining({ id: manual.id, source: 'manual' }),
    ])

    // The word gone: the sync owns extracted rows only.
    const without = await save(noteId, 'No term at all.')
    expect(without.mentions).toEqual({ added: [], removed: [] })
    expect(await mentionsFrom(noteId)).toEqual([
      expect.objectContaining({ id: manual.id, source: 'manual' }),
    ])
  })

  it('keeps [[mention]] chips and glossary matches in one diff', async () => {
    const pue = await makeTerm('PUE', null)
    const acme = await makeCompany('Acme Cooling')
    const noteId = await makeNote([])

    await save(noteId, `${pue.name} at Acme.`, [acme])
    expect(new Set((await mentionsFrom(noteId)).map((e) => e.to))).toEqual(
      new Set([pue.id, acme]),
    )

    // The word leaves, the chip stays: only the term edge goes.
    await save(noteId, 'Acme only.', [acme])
    expect((await mentionsFrom(noteId)).map((e) => e.to)).toEqual([acme])

    // The chip leaves, the word returns: only the chip edge goes.
    await save(noteId, `${pue.name} again.`, [])
    expect((await mentionsFrom(noteId)).map((e) => e.to)).toEqual([pue.id])
  })

  it('writes nothing the second time over unchanged text', async () => {
    const pue = await makeTerm('PUE', null)
    const noteId = await makeNote([])
    const text = `${pue.name}, twice: ${pue.name}.`

    const first = await save(noteId, text)
    expect(first.mentions).toEqual({ added: [pue.id], removed: [] })
    const before = await mentionsFrom(noteId)

    const second = await save(noteId, text)
    expect(second.mentions).toEqual({ added: [], removed: [] })
    // Same row, not a delete-and-reinsert that happens to look alike.
    expect(await mentionsFrom(noteId)).toEqual(before)
  })

  it('leaves the edges alone on a title-only save', async () => {
    const { saveNoteProgram } = await import('#/lib/notes/save')
    const pue = await makeTerm('PUE', null)
    const noteId = await makeNote([])
    await save(noteId, `${pue.name}.`)
    const before = await mentionsFrom(noteId)

    const result = await Effect.runPromise(
      saveNoteProgram(await actorId(), { id: noteId, title: 'Renamed' }),
    )
    expect(result.mentions).toBeNull()
    expect(await mentionsFrom(noteId)).toEqual(before)
  })
})

describe('term scope follows the note’s spaces, down the tree only', () => {
  it('does not match a term scoped to a space the note is not filed in', async () => {
    const aerospace = await makeSpace('Aerospace', null)
    const bio = await makeSpace('Bio', null)
    const stage = await makeTerm('stage', aerospace.id)
    const noteId = await makeNote([bio.id])

    await save(noteId, `The next ${stage.name} is a pivotal trial.`)

    expect(await mentionsFrom(noteId)).toEqual([])
  })

  it('matches a term inherited from an ancestor space', async () => {
    const dataCentres = await makeSpace('Data centers', null)
    const cooling = await makeSpace('Cooling', dataCentres)
    const immersion = await makeSpace('Immersion cooling', cooling)
    const pue = await makeTerm('PUE', dataCentres.id)
    const noteId = await makeNote([immersion.id])

    await save(noteId, `Immersion drops ${pue.name} below 1.05.`)

    expect((await mentionsFrom(noteId)).map((e) => e.to)).toEqual([pue.id])
  })

  it('never inherits upward: a child-space term does not reach the parent', async () => {
    const dataCentres = await makeSpace('Data centers', null)
    const cooling = await makeSpace('Cooling', dataCentres)
    const dielectric = await makeTerm('dielectric', cooling.id)
    const noteId = await makeNote([dataCentres.id])

    await save(noteId, `A ${dielectric.name} fluid.`)

    expect(await mentionsFrom(noteId)).toEqual([])
  })

  it('sees the union of every space a note is filed in', async () => {
    const aerospace = await makeSpace('Aerospace', null)
    const bio = await makeSpace('Bio', null)
    const leo = await makeTerm('LEO', aerospace.id)
    const ind = await makeTerm('IND', bio.id)
    const noteId = await makeNote([aerospace.id, bio.id])

    await save(noteId, `An ${ind.name} for drugs made in ${leo.name}.`)

    expect(new Set((await mentionsFrom(noteId)).map((e) => e.to))).toEqual(
      new Set([leo.id, ind.id]),
    )
  })

  it('a note filed nowhere matches global terms only', async () => {
    const aerospace = await makeSpace('Aerospace', null)
    const safe = await makeTerm('SAFE', null)
    const leo = await makeTerm('LEO', aerospace.id)
    const noteId = await makeNote([])

    await save(noteId, `A ${safe.name} for a ${leo.name} startup.`)

    expect((await mentionsFrom(noteId)).map((e) => e.to)).toEqual([safe.id])
  })

  it('hands the editor the same term set the sync matches against', async () => {
    const { db } = await import('@spaces/db')
    const { termsVisibleFrom } = await import('./link-terms')
    const aerospace = await makeSpace('Aerospace', null)
    const bio = await makeSpace('Bio', null)
    const safe = await makeTerm('SAFE', null)
    const leo = await makeTerm('LEO', aerospace.id)
    const ind = await makeTerm('IND', bio.id)
    const noteId = await makeNote([aerospace.id])

    const visible = new Set(
      (await termsVisibleFrom(db, noteId)).map((t) => t.id),
    )
    expect(visible.has(safe.id)).toBe(true)
    expect(visible.has(leo.id)).toBe(true)
    expect(visible.has(ind.id)).toBe(false)
  })
})

describe('linkDocumentTermsProgram — the standalone document sync', () => {
  async function makeDocument(text: string): Promise<string> {
    const { db } = await import('@spaces/db')
    const { document, entity } = await import('@spaces/db/schema')
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: 'deck.pdf' })
      .returning({ id: entity.id })
    await db.insert(document).values({
      entityId: ent.id,
      filename: 'deck.pdf',
      extractedText: text,
      extractionStatus: 'done',
    })
    return ent.id
  }

  it('links, then writes nothing over the same text', async () => {
    const { linkDocumentTermsProgram } = await import('./link-terms')
    const pue = await makeTerm('PUE', null)
    const documentId = await makeDocument(
      `[Slide 3] ${pue.name} 1.08, ${pue.name} audited.`,
    )

    const first = await Effect.runPromise(linkDocumentTermsProgram(documentId))
    expect(first).toEqual({ added: [pue.id], removed: [] })
    const before = await mentionsFrom(documentId)
    expect(before).toEqual([
      expect.objectContaining({ to: pue.id, source: 'extracted' }),
    ])

    const second = await Effect.runPromise(linkDocumentTermsProgram(documentId))
    expect(second).toEqual({ added: [], removed: [] })
    expect(await mentionsFrom(documentId)).toEqual(before)
  })
})
