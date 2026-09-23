import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * The term page's load (SPA-75), against the test database. The page is
 * everything the graph learned by matching a term — mentions with the
 * palette's snippets, companies reached through them, co-mentioned terms —
 * with canRead in the SQL. The file's database was truncated and reseeded
 * before it was imported (SPA-145); imports are dynamic because `@spaces/db`
 * builds its pool from `DATABASE_URL`, which `vitest.setup.ts` rewrites.
 */

async function deps() {
  const { db } = await import('@spaces/db')
  const schema = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const { termPageProgram } = await import('./term-page')

  const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!me) throw new Error('the test seed has no user')

  const newEntity = async (
    kind: 'company' | 'note' | 'document' | 'term' | 'space',
    name: string,
    createdAt?: Date,
  ) => {
    const row = (
      await db
        .insert(schema.entity)
        .values({ kind, canonicalName: name, ...(createdAt && { createdAt }) })
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

  const newTerm = async (
    name: string,
    aliases: Array<string> = [],
    spaceId: string | null = null,
  ) => {
    const id = await newEntity('term', name)
    await db.insert(schema.term).values({
      entityId: id,
      name,
      aliases,
      definitionMd: `${name}, defined.`,
      spaceId,
    })
    return id
  }

  const newNote = async (opts: {
    title: string
    body: string
    updatedAt: Date
    authorId?: string
    visibility?: 'shared' | 'private'
  }) => {
    const id = await newEntity('note', opts.title)
    await db.insert(schema.note).values({
      entityId: id,
      title: opts.title,
      bodyMd: opts.body,
      authorId: opts.authorId ?? me.id,
      visibility: opts.visibility ?? 'shared',
      updatedAt: opts.updatedAt,
    })
    return id
  }

  const newDeck = async (filename: string, text: string, createdAt: Date) => {
    const id = await newEntity('document', filename, createdAt)
    await db.insert(schema.document).values({
      entityId: id,
      filename,
      kind: 'deck',
      sourceClass: 'manual',
      extractionStatus: 'done',
      extractedText: text,
    })
    return id
  }

  const edge = async (
    from: string,
    to: string,
    relation: 'mentions' | 'tagged_in',
    source: 'manual' | 'extracted' = 'extracted',
  ) => {
    await db
      .insert(schema.link)
      .values({ fromEntityId: from, toEntityId: to, relation, source })
  }

  const page = (termId: string, userId = me.id) =>
    Effect.runPromise(termPageProgram(userId, termId))

  return {
    me: me.id,
    newEntity,
    teammate,
    newTerm,
    newNote,
    newDeck,
    edge,
    page,
  }
}

const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12))

describe('termPageProgram', () => {
  it('lists notes and documents that mention the term, newest first, with «»-marked snippets', async () => {
    const d = await deps()
    const pue = await d.newTerm('Power Usage Effectiveness', ['PUE'])
    const old = await d.newNote({
      title: 'Cooling call',
      body: 'The founders quoted a PUE of 1.08 across the pilot hall.',
      updatedAt: at(1),
    })
    const deck = await d.newDeck(
      'Series A deck.pdf',
      'Our immersion tanks bring power usage effectiveness below 1.05 at scale.',
      at(5),
    )
    const recent = await d.newNote({
      title: 'Site visit',
      body: 'Walked the hall; the PUE dashboard was live on the wall.',
      updatedAt: at(9),
    })
    const company = await d.newEntity('company', 'Coolant Labs')
    await d.edge(deck, company, 'tagged_in')
    for (const from of [old, deck]) await d.edge(from, pue, 'mentions')
    // A deliberate [[PUE]] is a manual mention — any source counts.
    await d.edge(recent, pue, 'mentions', 'manual')

    const got = await d.page(pue)

    expect(got?.term).toMatchObject({
      id: pue,
      name: 'Power Usage Effectiveness',
      aliases: ['PUE'],
      space: null,
    })
    expect(got?.mentions.total).toBe(3)
    expect(got?.mentions.rows.map((r) => r.id)).toEqual([recent, deck, old])
    const [first, second, third] = got?.mentions.rows ?? []
    expect(first).toMatchObject({ kind: 'note', subKind: 'note' })
    expect(first.snippet).toContain('«PUE»')
    // The name marks as a phrase, through the same options Cmd-K cuts with.
    expect(second).toMatchObject({
      kind: 'document',
      subKind: 'deck',
      parent: { id: company, kind: 'company', name: 'Coolant Labs' },
    })
    expect(second.snippet).toMatch(/«power» «usage» «effectiveness»/i)
    expect(third.snippet).toContain('«PUE»')
    for (const r of got?.mentions.rows ?? [])
      expect(r.snippet).not.toMatch(/<\/?b>/)
  })

  it('reaches companies through filing and mentions, ranked by how many items reach them', async () => {
    const d = await deps()
    const tam = await d.newTerm('Serviceable market')
    const n1 = await d.newNote({ title: 'A', body: 'x', updatedAt: at(1) })
    const n2 = await d.newNote({ title: 'B', body: 'x', updatedAt: at(2) })
    const deck = await d.newDeck('deck.pdf', 'x', at(3))
    for (const from of [n1, n2, deck]) await d.edge(from, tam, 'mentions')

    const alpha = await d.newEntity('company', 'Alpha Rockets')
    const zulu = await d.newEntity('company', 'Zulu Fusion')
    const bravo = await d.newEntity('company', 'Bravo Bio')
    const bystander = await d.newEntity('company', 'Not Reached')
    // Zulu: filed on by n1 and named by n2 and the deck → three items.
    await d.edge(n1, zulu, 'tagged_in')
    await d.edge(n2, zulu, 'mentions')
    await d.edge(deck, zulu, 'tagged_in')
    // Alpha and Bravo: one item each — the tie breaks on name.
    await d.edge(n1, bravo, 'mentions')
    await d.edge(deck, alpha, 'tagged_in')
    // A company the term's items never touch stays out, even if linked
    // from something else.
    const unrelated = await d.newNote({
      title: 'C',
      body: 'x',
      updatedAt: at(4),
    })
    await d.edge(unrelated, bystander, 'tagged_in')

    const got = await d.page(tam)

    expect(got?.companies.total).toBe(3)
    expect(got?.companies.rows).toEqual([
      { id: zulu, name: 'Zulu Fusion', reach: 3 },
      { id: alpha, name: 'Alpha Rockets', reach: 1 },
      { id: bravo, name: 'Bravo Bio', reach: 1 },
    ])
  })

  it('computes co-mentioned terms from shared mention sources, and answers none as an empty list', async () => {
    const d = await deps()
    const target = await d.newTerm('Stack lifetime')
    const often = await d.newTerm('Degradation rate')
    const once = await d.newTerm('Balance of plant')
    const elsewhere = await d.newTerm('Never together')
    const n1 = await d.newNote({ title: 'A', body: 'x', updatedAt: at(1) })
    const n2 = await d.newNote({ title: 'B', body: 'x', updatedAt: at(2) })
    const n3 = await d.newNote({ title: 'C', body: 'x', updatedAt: at(3) })
    for (const from of [n1, n2]) await d.edge(from, target, 'mentions')
    for (const from of [n1, n2]) await d.edge(from, often, 'mentions')
    await d.edge(n2, once, 'mentions')
    await d.edge(n3, elsewhere, 'mentions')

    const got = await d.page(target)
    expect(got?.coMentioned).toEqual([
      { id: often, name: 'Degradation rate', shared: 2 },
      { id: once, name: 'Balance of plant', shared: 1 },
    ])

    const alone = await d.page(elsewhere)
    expect(alone?.coMentioned).toEqual([])

    const unmentioned = await d.newTerm('Orphan word')
    const empty = await d.page(unmentioned)
    expect(empty?.mentions).toEqual({ rows: [], total: 0 })
    expect(empty?.companies).toEqual({ rows: [], total: 0 })
    expect(empty?.coMentioned).toEqual([])
  })

  it("never shows a teammate's private note — not as a mention, not as a reach, not as a co-mention", async () => {
    const d = await deps()
    const other = await d.teammate()
    const term = await d.newTerm('Round-trip efficiency')
    const secretTerm = await d.newTerm('Secret sauce')
    const theirs = await d.newNote({
      title: 'Their private read',
      body: 'Round-trip efficiency looked weak.',
      updatedAt: at(2),
      authorId: other,
      visibility: 'private',
    })
    const mine = await d.newNote({
      title: 'My private read',
      body: 'Round-trip efficiency looked fine.',
      updatedAt: at(1),
      visibility: 'private',
    })
    const hidden = await d.newEntity('company', 'Hidden Storage Co')
    await d.edge(theirs, term, 'mentions')
    await d.edge(theirs, secretTerm, 'mentions')
    await d.edge(theirs, hidden, 'tagged_in')
    await d.edge(mine, term, 'mentions')

    const forMe = await d.page(term)
    expect(forMe?.mentions.rows.map((r) => r.id)).toEqual([mine])
    expect(forMe?.mentions.total).toBe(1)
    expect(forMe?.companies.rows).toEqual([])
    expect(forMe?.coMentioned).toEqual([])

    // The author sees their own note, and what it reaches.
    const forThem = await d.page(term, other)
    expect(forThem?.mentions.rows.map((r) => r.id)).toEqual([theirs])
    expect(forThem?.companies.rows.map((c) => c.id)).toEqual([hidden])
    expect(forThem?.coMentioned.map((t) => t.id)).toEqual([secretTerm])
  })

  it('names the space a term is defined in, and answers null for no such term', async () => {
    const d = await deps()
    const { db } = await import('@spaces/db')
    const { space } = await import('@spaces/db/schema')
    const spaceId = await d.newEntity('space', 'Hyperscale halls')
    // The starter taxonomy is seeded, so the slug is one it does not carry.
    await db.insert(space).values({
      entityId: spaceId,
      slug: 'hyperscale_halls',
      path: 'hyperscale_halls',
    })
    const term = await d.newTerm('Hot aisle', [], spaceId)

    const got = await d.page(term)
    expect(got?.term.space).toEqual({ id: spaceId, name: 'Hyperscale halls' })
    expect(await d.page(randomUUID())).toBeNull()
  })

  it('cuts snippets with the exported HEADLINE_OPTIONS and applies canRead through canReadNoteSql', () => {
    // Read from source: a second options string or a hand-rolled
    // visibility clause would read as a different product.
    const source = readFileSync(
      new URL('./term-page.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('HEADLINE_OPTIONS')
    expect(source).not.toContain('StartSel')
    expect(source).toContain('canReadNoteSql(userId)')
    expect(source).not.toMatch(/visibility/)
  })
})
