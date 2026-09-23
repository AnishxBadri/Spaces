import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { recordPath } from '../record-path'

/**
 * Cmd-K's fused query (SPA-148). Three slices are queued to rewrite it — a
 * parent lane, a task lane, a vector lane — and each must keep these four
 * invariants. A rewrite that drops one fails here, not in the palette:
 *
 *   1. One RRF, with k = 60, in one place. The final select sums
 *      1 / (60 + rank) per fused key, and nothing else scores. A second k,
 *      or a lane fused in Node, is a regression. The key is
 *      `(row_kind, id)` since the task lane (SPA-55): name, note and
 *      document lanes rank entity ids, the task lane ranks task ids, and
 *      the two id spaces never sum into one row.
 *   2. Snippets are marked «like this» (`HEADLINE_OPTIONS`) and the palette
 *      renders them as text, never as HTML — no `<b>`, no
 *      dangerouslySetInnerHTML, one headline options string.
 *   3. Each lane is limited to 40 rows; the fused answer to 20.
 *   4. canRead is in the SQL, on every lane that can reach a note
 *      (`canReadNoteSql`). A teammate's private note never enters the
 *      fusion; the searcher's own private note does. The task lane cannot
 *      reach a note and tasks carry no visibility flag, so it takes none.
 *
 * The file's database was truncated and reseeded before it was imported
 * (SPA-145), so the fixtures below are the whole corpus the words they use
 * can reach — and nothing here cleans up after itself, `task` rows
 * included: the next file starts from the same truncate. Imports are
 * dynamic: `@spaces/db` builds its pool from `DATABASE_URL`, which
 * `vitest.setup.ts` rewrites per file.
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
    kind: 'company' | 'note' | 'document' | 'space',
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

  const fileOn = async (
    documentId: string,
    recordId: string,
    edge: { id?: string; createdAt?: Date } = {},
  ) => {
    await db.insert(schema.link).values({
      fromEntityId: documentId,
      toEntityId: recordId,
      relation: 'tagged_in',
      ...edge,
    })
  }

  const newSpace = async (name: string) => {
    const id = await newEntity('space', name)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    await db.insert(schema.space).values({
      entityId: id,
      slug,
      path: slug,
    })
    return id
  }

  /** The row docsurf-1a's `{ kind: 'space' }` filing branch writes. */
  const fileInSpace = async (documentId: string, spaceId: string) => {
    await db
      .insert(schema.entitySpace)
      .values({ entityId: documentId, spaceId, createdBy: me.id })
  }

  /** A task as the composer writes it; `tsv` is generated (migration 0046). */
  const newTask = async (
    content: string,
    opts: {
      id?: string
      dueDate?: string
      doneAt?: Date
      userId?: string
    } = {},
  ) => {
    const { userId = me.id, ...rest } = opts
    const row = (
      await db
        .insert(schema.task)
        .values({ content, assigneeId: userId, createdBy: userId, ...rest })
        .returning({ id: schema.task.id })
    ).at(0)
    if (!row) throw new Error('task insert returned nothing')
    return row.id
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
    newSpace,
    fileInSpace,
    newTask,
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

  it('sends a deck filed only into a space to that space', async () => {
    const { newDeck, newSpace, fileInSpace, search } = await deps()
    const space = await newSpace('Grid Storage')
    const deck = await newDeck(
      'Flow battery primer.pdf',
      'Vanadium brinecast stacks trade energy density for cycle life.',
    )
    await fileInSpace(deck, space)

    const hit = (await search('brinecast')).find((h) => h.id === deck)
    expect(hit?.parent).toEqual({
      id: space,
      kind: 'space',
      name: 'Grid Storage',
      objectSlug: null,
    })
    // The palette's destination is `recordPath` over the parent — `hrefFor`
    // (command-palette.tsx) builds exactly this target for a document hit
    // and adds no branch of its own, so a non-null path is an enabled row.
    // Its meta lane is `in ${parent.name}`.
    if (!hit?.parent) throw new Error('the deck resolved no parent')
    const { id, kind, objectSlug } = hit.parent
    expect(recordPath({ kind, id, objectSlug })).toBe(`/spaces/${space}`)
    expect(`in ${hit.parent.name}`).toBe('in Grid Storage')
  })

  it('prefers the record a deck is filed on over a space it is also in', async () => {
    const { newEntity, newDeck, newSpace, fileOn, fileInSpace, search } =
      await deps()
    const company = await newEntity('company', 'Ferrovane Systems')
    const space = await newSpace('Heavy Industry')
    const deck = await newDeck(
      'Ferrovane seed deck.pdf',
      'Our quenchline furnace retrofit halves coke use in blast furnaces.',
    )
    // The space edge is the older one: precedence is by kind, not by age.
    await fileInSpace(deck, space)
    await fileOn(deck, company)

    const hit = (await search('quenchline')).find((h) => h.id === deck)
    expect(hit?.parent).toMatchObject({ id: company, kind: 'company' })
  })

  it('sends a deck filed on two records to the one it was filed on first', async () => {
    const { newEntity, newDeck, fileOn, search } = await deps()
    const first = await newEntity('company', 'Aldermoor Labs')
    const second = await newEntity('company', 'Brackwater Energy')
    const deck = await newDeck(
      'Joint venture memo.pdf',
      'The tidewright turbine program is shared between both companies.',
    )
    // Written newest-first, so heap order and filing order disagree.
    await fileOn(deck, second, { createdAt: new Date('2026-03-02T00:00:00Z') })
    await fileOn(deck, first, { createdAt: new Date('2026-03-01T00:00:00Z') })

    for (let i = 0; i < 3; i++) {
      const hit = (await search('tidewright')).find((h) => h.id === deck)
      expect(hit?.parent).toMatchObject({ id: first, name: 'Aldermoor Labs' })
    }

    // Filed in the same instant, the lower edge id wins.
    const other = await newDeck(
      'Consortium update.pdf',
      'Brineweld pilot results from the consortium partners.',
    )
    const at = new Date('2026-04-01T00:00:00Z')
    await fileOn(other, first, {
      id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      createdAt: at,
    })
    await fileOn(other, second, {
      id: '00000000-0000-4000-8000-000000000000',
      createdAt: at,
    })
    const tied = (await search('brineweld')).find((h) => h.id === other)
    expect(tied?.parent).toMatchObject({ id: second })
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

describe('the task lane (SPA-55)', () => {
  it('returns a task alongside a company of the same name, each marked with its row kind', async () => {
    const { newEntity, newTask, search } = await deps()
    const company = await newEntity('company', 'Runway')
    const task = await newTask(
      'Ask the founders how much runway is left after the bridge',
      { dueDate: '2026-10-01' },
    )

    const hits = await search('runway')

    expect(hits.find((h) => h.id === company)).toMatchObject({
      rowKind: 'entity',
      kind: 'company',
      name: 'Runway',
      task: null,
    })
    const hit = hits.find((h) => h.rowKind === 'task' && h.id === task)
    expect(hit).toMatchObject({
      rowKind: 'task',
      kind: 'task',
      name: 'Ask the founders how much runway is left after the bridge',
      objectSlug: null,
      matchedIn: 'task',
      parent: null,
      task: { dueDate: '2026-10-01', done: false },
    })
    expect(hit?.snippet).toContain('«runway»')
    expect(hit?.snippet).not.toMatch(/<\/?b>/)
  })

  it('keeps two tasks and a company apart — three rows, each once, even when a task shares the company id', async () => {
    const { newEntity, newTask, search } = await deps()
    const company = await newEntity('company', 'Pellucid Tidewater')
    // The same uuid in both id spaces: fused on `id` alone these two would
    // sum into one row and one of them would vanish.
    const twin = await newTask('Send Pellucid the revised term sheet', {
      id: company,
    })
    const other = await newTask('Pellucid reference call with the CFO')
    expect(twin).toBe(company)

    const hits = await search('pellucid')

    expect(hits).toHaveLength(3)
    const keys = hits.map((h) => `${h.rowKind}:${h.id}`)
    expect(new Set(keys).size).toBe(3)
    expect(keys.sort()).toEqual(
      [`entity:${company}`, `task:${twin}`, `task:${other}`].sort(),
    )
    expect(hits.find((h) => h.rowKind === 'entity')?.name).toBe(
      'Pellucid Tidewater',
    )
  })

  it('still matches a completed task and says it is done', async () => {
    const { newTask, search } = await deps()
    const open = await newTask('Chase the Quorlane data room access')
    const done = await newTask('Book the Quorlane site visit', {
      doneAt: new Date('2026-09-01T12:00:00Z'),
    })

    const hits = await search('quorlane')

    expect(hits.find((h) => h.id === done)?.task).toEqual({
      dueDate: null,
      done: true,
    })
    expect(hits.find((h) => h.id === open)?.task).toEqual({
      dueDate: null,
      done: false,
    })
  })

  it("shows a teammate's task but not their private note, and a space-filed deck still routes to its space", async () => {
    const {
      me,
      teammate,
      newNote,
      newTask,
      newDeck,
      newSpace,
      fileInSpace,
      search,
    } = await deps()
    const other = await teammate()
    const privateNote = await newNote({
      title: 'Diligence scratch',
      body: 'Marrowgate churn looks worse than the deck admits.',
      authorId: other,
      visibility: 'private',
    })
    const theirTask = await newTask('Pull the Marrowgate cohort data', {
      userId: other,
    })
    const space = await newSpace('Vertical SaaS')
    const deck = await newDeck(
      'Marrowgate seed deck.pdf',
      'Marrowgate automates compliance filings for regional lenders.',
    )
    await fileInSpace(deck, space)

    const hits = await search('marrowgate', me)

    expect(hits.map((h) => h.id)).not.toContain(privateNote)
    expect(hits.find((h) => h.id === theirTask)).toMatchObject({
      rowKind: 'task',
    })
    expect(hits.find((h) => h.id === deck)?.parent).toMatchObject({
      id: space,
      kind: 'space',
    })
  })

  it('sums one RRF across all four lanes: each lane scores 1/(60+r), a task at rank 1 as much as a note', async () => {
    const { me, newDeck, newNote, newTask, fused } = await deps()
    const deck = await newDeck(
      'Glimmerfen overview.pdf',
      'Glimmerfen builds peat-free substrates for vertical farms.',
    )
    const note = await newNote({
      title: 'Partner meeting',
      body: 'Discussed the glimmerfen pilot with the grower.',
      authorId: me,
      visibility: 'shared',
    })
    const task = await newTask('Glimmerfen: send the grower intro')

    const rows = await fused('glimmerfen')

    const sources = new Set(rows.flatMap((r) => r.sources))
    expect([...sources].sort()).toEqual(['document', 'name', 'note', 'task'])
    const taskRow = rows.find((r) => r.row_kind === 'task' && r.id === task)
    expect(taskRow?.sources).toEqual(['task'])
    expect(Number(taskRow?.score)).toBeCloseTo(1 / (60 + 1), 12)
    const noteRow = rows.find((r) => r.id === note)
    expect(Number(noteRow?.score)).toBeCloseTo(Number(taskRow?.score), 12)
    const deckRow = rows.find((r) => r.id === deck)
    expect(Number(deckRow?.score)).toBeCloseTo(2 / (60 + 1), 12)
  })

  it('spells k = 60 once, limits each of the four lanes to 40 and the answer to 20', () => {
    // Read from source: the per-lane limit is invisible behind the final 20,
    // and "one k" is a claim about the statement, not about any one answer.
    const source = readFileSync(new URL('./query.ts', import.meta.url), 'utf8')
    expect(source.match(/\b60 \+/g)).toHaveLength(1)
    expect(source.match(/limit 40\b/g)).toHaveLength(4)
    expect(source.match(/limit 20\b/g)).toHaveLength(1)
  })

  it('answers at most 20 hits when tasks alone match', async () => {
    const { newTask, search } = await deps()
    for (let i = 1; i <= 25; i++)
      await newTask(`Follow up with Vornholt contact ${i}`)

    const hits = await search('vornholt')
    expect(hits).toHaveLength(20)
    expect(hits.every((h) => h.rowKind === 'task')).toBe(true)
  })
})
