import { describe, expect, it } from 'vitest'

/**
 * The database half of citation labels, on the test database: a ref that
 * names a merged loser reads as the winner, and the document / mandate /
 * term lookups reach the table that holds the name a person knows.
 */
describe('citeLookupProgram', () => {
  it('resolves a merged loser to the winner, and names docs, terms and the mandate', async () => {
    const { Effect } = await import('effect')
    const { eq } = await import('drizzle-orm')
    const { db } = await import('@spaces/db')
    const { document, entity, mandate, note, term } =
      await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { citeLookupProgram } = await import('./names')
    const { cite } = await import('./cite')
    const { ref } = await import('./ref')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)

    const [winner] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: 'Acme Winner' })
      .returning({ id: entity.id })
    const [loser] = await db
      .insert(entity)
      .values({
        kind: 'company',
        canonicalName: 'Acme Loser',
        mergedIntoId: winner.id,
      })
      .returning({ id: entity.id })

    const [docEnt] = await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: 'Deck entity' })
      .returning({ id: entity.id })
    // Exempt from the one-writer rule: a fixture row, nothing to extract.
    await db.insert(document).values({
      entityId: docEnt.id,
      filename: 'deck.pdf',
      kind: 'deck',
      sourceClass: 'manual',
      extractionStatus: 'done',
    })

    const [termEnt] = await db
      .insert(entity)
      .values({ kind: 'term', canonicalName: 'term entity' })
      .returning({ id: entity.id })
    await db.insert(term).values({ entityId: termEnt.id, name: 'ARR' })

    const [mandateNote] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: 'Mandate' })
      .returning({ id: entity.id })
    await db.insert(note).values({
      entityId: mandateNote.id,
      title: 'Mandate',
      bodyMd: '',
      kind: 'note',
      authorId: me.id,
      visibility: 'shared',
    })
    const [m] = await db
      .insert(mandate)
      .values({ noteEntityId: mandateNote.id })
      .returning({ id: mandate.id })

    const refs = [
      ref.attr(loser.id, 'funding_stage'),
      ref.note(loser.id),
      ref.doc(docEnt.id, 4),
      ref.term(termEnt.id),
      ref.mandate(m.id),
    ]
    const lookup = await Effect.runPromise(citeLookupProgram(refs))

    expect(lookup.mergedInto(loser.id)).toBe(winner.id)
    expect(cite(refs[0], lookup)).toBe('Funding stage on Acme Winner')
    expect(cite(refs[1], lookup)).toBe('Acme Winner')
    expect(cite(refs[2], lookup)).toBe('deck.pdf · chunk 4')
    expect(cite(refs[3], lookup)).toBe('ARR')
    expect(cite(refs[4], lookup)).toBe('the mandate')

    // the loser row itself is untouched — the redirect is read, not written
    const [still] = await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, loser.id))
    expect(still.name).toBe('Acme Loser')
  })
})
