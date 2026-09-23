import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Cmd-K's fused query (SPA-148). Three slices are queued to rewrite it — a
 * parent lane, a task lane, a vector lane — and each must keep these four
 * invariants. A rewrite that drops one fails here, not in the palette:
 *
 *   1. One RRF over one id space, with k = 60, in one place. Every lane
 *      ranks entity ids; the final select sums 1 / (60 + rank) over them,
 *      and nothing else scores. A second k, or a lane fused in Node, is a
 *      regression.
 *   2. Snippets are marked «like this» (`HEADLINE_OPTIONS`) and the palette
 *      renders them as text, never as HTML — no `<b>`, no
 *      dangerouslySetInnerHTML, one headline options string.
 *   3. Each lane is limited to 40 rows; the fused answer to 20.
 *   4. canRead is in the SQL, on every lane that can reach a note
 *      (`canReadNoteSql`). A teammate's private note never enters the
 *      fusion; the searcher's own private note does.
 *
 * The file's database was truncated and reseeded before it was imported
 * (SPA-145), so the fixtures below are the whole corpus the words they use
 * can reach. Imports are dynamic: `@spaces/db` builds its pool from
 * `DATABASE_URL`, which `vitest.setup.ts` rewrites per file.
 */

async function deps() {
  const { Effect } = await import('effect')
  const { sql } = await import('drizzle-orm')
  const { db } = await import('@spaces/db')
  const schema = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const { searchAllProgram, fusedRowsProgram } = await import('./query')

  const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!me) throw new Error('the test seed has no user')

  const newEntity = async (
    kind: 'company' | 'note' | 'document',
    name: string,
  ) => {
    const row = (
      await db
        .insert(schema.entity)
        .values({ kind, canonicalName: name })
        .returning({ id: schema.entity.id })
    ).at(0)
    if (!row) throw new Error('entity insert returned nothing')
    return row.id
  }

  const teammate = async () => {
    const row = (
      await db
        .insert(user)
        .values({
          id: randomUUID(),
          name: 'Other Partner',
          email: `${randomUUID()}@fund.example`,
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: user.id })
    ).at(0)
    if (!row) throw new Error('user insert returned nothing')
    return row.id
  }

  const newNote = async (opts: {
    title: string
    body: string
    authorId: string
    visibility: 'shared' | 'private'
  }) => {
    const id = await newEntity('note', opts.title)
    // `tsv` is generated from title + body_md (migration 0009).
    await db.insert(schema.note).values({
      entityId: id,
      title: opts.title,
      bodyMd: opts.body,
      authorId: opts.authorId,
      visibility: opts.visibility,
    })
    return id
  }

  /** A deck as extraction leaves it: text and tsv written together. */
  const newDeck = async (filename: string, text: string) => {
    const id = await newEntity('document', filename)
    await db.insert(schema.document).values({
      entityId: id,
      filename,
      kind: 'deck',
      sourceClass: 'manual',
      extractionStatus: 'done',
      extractedText: text,
      tsv: sql`to_tsvector('english', ${text})`,
    })
    return id
  }

  const fileOn = async (documentId: string, recordId: string) => {
    await db.insert(schema.link).values({
      fromEntityId: documentId,
      toEntityId: recordId,
      relation: 'tagged_in',
    })
  }

  const search = (q: string, userId = me.id) =>
    Effect.runPromise(searchAllProgram({ userId, q }))
  const fused = (q: string, userId = me.id) =>
    Effect.runPromise(fusedRowsProgram({ userId, q }))

  return {
    me: me.id,
    newEntity,
    teammate,
    newNote,
    newDeck,
    fileOn,
    search,
    fused,
  }
}

describe('searchAllProgram', () => {
  it('finds a company by a typo in its name', async () => {
    const { newEntity, search } = await deps()
    const id = await newEntity('company', 'Orbital Composites')

    const hits = await search('orbitl')

    const hit = hits.find((h) => h.id === id)
    expect(hit).toMatchObject({
      kind: 'company',
      name: 'Orbital Composites',
      matchedIn: 'name',
      snippet: null,
      parent: null,
    })
  })

  it('finds a note by its body, with a «»-marked snippet', async () => {
    const { me, newNote, search } = await deps()
    const id = await newNote({
      title: 'Weekly sync',
      body: 'We walked through the quillframe tooling roadmap with both founders and the lead investor.',
      authorId: me,
      visibility: 'shared',
    })

    const hits = await search('quillframe')

    const hit = hits.find((h) => h.id === id)
    expect(hit?.matchedIn).toBe('note')
    expect(hit?.snippet).toContain('«quillframe»')
    // The marks are the only markup: ts_headline's default <b> never appears.
    expect(hit?.snippet).not.toMatch(/<\/?b>/)
  })

  it('finds a deck by its extracted text and returns the record it is filed on', async () => {
    const { newEntity, newDeck, fileOn, search } = await deps()
    const company = await newEntity('company', 'Helios Foundry')
    const deck = await newDeck(
      'Series A deck.pdf',
      'Our cryoweave process cuts cell cost by forty percent at pilot scale.',
    )
    await fileOn(deck, company)

    const hits = await search('cryoweave')

    const hit = hits.find((h) => h.id === deck)
    expect(hit).toMatchObject({
      kind: 'document',
      matchedIn: 'document',
      parent: { id: company, kind: 'company', name: 'Helios Foundry' },
    })
    expect(hit?.snippet).toContain('«cryoweave»')
  })

  it("never returns a teammate's private note, and does return the searcher's own", async () => {
    const { me, teammate, newNote, search } = await deps()
    const other = await teammate()
    // Both reachable by two lanes: the title through name_hits, the body
    // through note_hits. canRead has to hold on each.
    const theirs = await newNote({
      title: 'Kelvinshard reference calls',
      body: 'Kelvinshard reference calls were mixed; one former customer churned.',
      authorId: other,
      visibility: 'private',
    })
    const mine = await newNote({
      title: 'Kelvinshard first meeting',
      body: 'Kelvinshard pitched a second fab; the numbers need work.',
      authorId: me,
      visibility: 'private',
    })
    const theirsShared = await newNote({
      title: 'Kelvinshard market map',
      body: 'Kelvinshard sits between two incumbents.',
      authorId: other,
      visibility: 'shared',
    })

    const ids = (await search('kelvinshard')).map((h) => h.id)
    expect(ids).toContain(mine)
    expect(ids).toContain(theirsShared)
    expect(ids).not.toContain(theirs)

    // …and the teammate sees their own, but not mine.
    const theirIds = (await search('kelvinshard', other)).map((h) => h.id)
    expect(theirIds).toContain(theirs)
    expect(theirIds).not.toContain(mine)
  })

  it('scores a two-lane hit 1/(60+r1) + 1/(60+r2), above a one-lane hit at the same rank', async () => {
    const { me, newDeck, newNote, fused, search } = await deps()
    // The deck is rank 1 in name_hits (its name) and rank 1 in doc_hits
    // (its text); the note is rank 1 in note_hits and in no other lane.
    const deck = await newDeck(
      'Zanthrope overview.pdf',
      'Zanthrope makes membrane stacks for industrial electrolysis.',
    )
    const note = await newNote({
      title: 'Call notes',
      body: 'Asked about zanthrope supply terms before the partner meeting.',
      authorId: me,
      visibility: 'shared',
    })

    const rows = await fused('zanthrope')
    const deckRow = rows.find((r) => r.id === deck)
    const noteRow = rows.find((r) => r.id === note)
    expect([...(deckRow?.sources ?? [])].sort()).toEqual(['document', 'name'])
    expect(noteRow?.sources).toEqual(['note'])
    expect(Number(deckRow?.score)).toBeCloseTo(1 / (60 + 1) + 1 / (60 + 1), 12)
    expect(Number(noteRow?.score)).toBeCloseTo(1 / (60 + 1), 12)

    // The palette's order is the fused order.
    const order = (await search('zanthrope')).map((h) => h.id)
    expect(order.indexOf(deck)).toBeLessThan(order.indexOf(note))
    expect(order.indexOf(note)).toBeGreaterThanOrEqual(0)
  })

  it('answers at most 20 hits', async () => {
    const { newEntity, search } = await deps()
    for (let i = 1; i <= 25; i++)
      await newEntity('company', `Tessellon ${String(i).padStart(2, '0')}`)

    expect(await search('tessellon')).toHaveLength(20)
  })

  it('answers nothing for a query under two characters', async () => {
    const { newEntity, search } = await deps()
    await newEntity('company', 'X Labs')

    expect(await search(' x ')).toEqual([])
  })
})
