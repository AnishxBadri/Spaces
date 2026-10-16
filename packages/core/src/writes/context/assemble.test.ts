import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SimilarCandidate } from '../../context/similar-lane'

const ASOF = '2026-09-10T00:00:00Z'

/**
 * Integration test on the test database: builds a company with everything
 * the walk can reach — attributes, alias, history, memo, shared note, a
 * teammate's private note, a deck with chunks, a space with a memo, a task,
 * an interaction — assembles it as two users, and snapshots the shape.
 *
 * In core since SPA-182: the judgment-memory lane is the `SimilarLane`
 * service, and these tests provide a stub of it — the empty lane for the
 * walk, a lane that hands back a private note for the leak invariant.
 */
describe('assembleProgram', () => {
  const tag = randomUUID().slice(0, 8)
  const ids: Record<string, string> = {}

  it('assembles the record for two users, deterministically', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { assembleProgram } = await import('./assemble')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const {
      attributeEvent,
      chunk,
      document,
      entity,
      entitySpace,
      link,
      note,
      space,
    } = await import('@spaces/db/schema')
    const { task, taskEntity } = await import('@spaces/db/schema/tasks')
    const { interaction, interactionEntity } =
      await import('@spaces/db/schema/interactions')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    expect(me).toBeTruthy()
    const [teammate] = await db
      .insert(user)
      .values({
        id: `ctx-teammate-${tag}`,
        name: `Teammate ${tag}`,
        email: `teammate-${tag}@example.test`,
      })
      .returning({ id: user.id })

    const co = await resolveEntity({
      kind: 'company',
      name: `CtxCo ${tag}`,
      keys: { domain: `ctxco-${tag}.com` },
      source: { class: 'manual' },
    })
    ids.co = co.entityId
    // Birth stamped the domains event with the clock; the snapshot needs a day.
    await db
      .update(attributeEvent)
      .set({ at: new Date('2026-08-29T09:00:00Z') })
      .where(eq(attributeEvent.entityId, co.entityId))
    await db
      .update(entity)
      .set({ values: { funding_stage: 'seed', location: 'Bengaluru' } })
      .where(eq(entity.id, co.entityId))
    await db.insert(attributeEvent).values({
      entityId: co.entityId,
      attrSlug: 'funding_stage',
      from: null,
      to: 'seed',
      actorType: 'user',
      actorId: me.id,
      at: new Date('2026-08-29T10:00:00Z'),
    })

    const mkNote = async (
      name: string,
      body: {
        title: string
        bodyMd: string
        kind: 'note' | 'memo'
        authorId: string
        visibility: 'shared' | 'private'
      },
      to: string,
      relation: 'mentions' | 'tagged_in',
    ) => {
      const [e] = await db
        .insert(entity)
        .values({ kind: 'note', canonicalName: name })
        .returning({ id: entity.id })
      await db.insert(note).values({
        entityId: e.id,
        ...body,
        updatedAt: new Date('2026-08-21T00:00:00Z'),
      })
      await db.insert(link).values({
        fromEntityId: e.id,
        toEntityId: to,
        relation,
        source: 'manual',
      })
      return e.id
    }
    ids.memo = await mkNote(
      `CtxMemo ${tag}`,
      {
        title: 'Thesis fit',
        bodyMd: 'Power density is the wedge.',
        kind: 'memo',
        authorId: me.id,
        visibility: 'shared',
      },
      co.entityId,
      'tagged_in',
    )
    ids.note = await mkNote(
      `CtxNote ${tag}`,
      {
        title: 'Call notes',
        bodyMd: 'Met Priya, pilot at Tata Comms.',
        kind: 'note',
        authorId: me.id,
        visibility: 'shared',
      },
      co.entityId,
      'mentions',
    )
    ids.priv = await mkNote(
      `CtxPriv ${tag}`,
      {
        title: 'Private doubts',
        bodyMd: 'Not sure about the CTO.',
        kind: 'note',
        authorId: teammate.id,
        visibility: 'private',
      },
      co.entityId,
      'mentions',
    )

    const [docEnt] = await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: `CtxDoc ${tag}` })
      .returning({ id: entity.id })
    ids.doc = docEnt.id
    // Exempt from the one-writer rule: a test fixture, wanting a row with
    // `extraction_status: 'done'` and extracted text already in it.
    await db.insert(document).values({
      entityId: docEnt.id,
      filename: 'seed-deck.pdf',
      kind: 'deck',
      sourceClass: 'manual',
      extractionStatus: 'done',
      createdAt: new Date('2026-08-20T00:00:00Z'),
    })
    await db.insert(chunk).values(
      [
        'Problem: edge DCs run hot.',
        'Team: Priya Rao, ex-Tata Power.',
        'Pilot: 40% PUE improvement.',
      ].map((text, idx) => ({
        entityId: docEnt.id,
        sourceKind: 'document' as const,
        idx,
        text,
      })),
    )
    await db.insert(link).values({
      fromEntityId: docEnt.id,
      toEntityId: co.entityId,
      relation: 'tagged_in',
      source: 'manual',
    })

    const [spc] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `CtxSpace ${tag}` })
      .returning({ id: entity.id })
    ids.space = spc.id
    await db.insert(space).values({
      entityId: spc.id,
      slug: `ctxspace_${tag}`,
      path: `ctxspace_${tag}`,
    })
    await db
      .insert(entitySpace)
      .values({ entityId: co.entityId, spaceId: spc.id, source: 'manual' })
    ids.spaceMemo = await mkNote(
      `CtxMemo ${tag} space`,
      {
        title: 'Why cooling',
        bodyMd: 'Power density is rising.',
        kind: 'memo',
        authorId: me.id,
        visibility: 'shared',
      },
      spc.id,
      'tagged_in',
    )

    const [t] = await db
      .insert(task)
      .values({
        content: `revisit ${tag}`,
        dueDate: '2026-10-15',
        assigneeId: me.id,
        createdBy: me.id,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      })
      .returning({ id: task.id })
    ids.task = t.id
    await db.insert(taskEntity).values({ taskId: t.id, entityId: co.entityId })

    const [i] = await db
      .insert(interaction)
      .values({
        kind: 'call',
        subject: 'Intro call',
        occurredAt: new Date('2026-08-29T11:00:00Z'),
      })
      .returning({ id: interaction.id })
    ids.interaction = i.id
    await db
      .insert(interactionEntity)
      .values({ interactionId: i.id, entityId: co.entityId })

    // ---- as me ----
    const run = (userId: string, taskText?: string) =>
      Effect.runPromise(
        assembleProgram(
          { entityId: co.entityId },
          { user: { id: userId }, asOf: ASOF, budgetChars: 8000, taskText },
        ).pipe(Effect.provide(SimilarLaneEmpty)),
      )
    const mine = await run(me.id)
    const refs = mine.items.map((x) => x.ref)

    expect(mine.seed.id).toBe(co.entityId)
    expect(refs).toContain(`attr:${co.entityId}:funding_stage`)
    expect(refs).toContain(`attr:${co.entityId}:alias.domain`)
    expect(refs).toContain(`memo:${ids.memo}`)
    expect(refs).toContain(`note:${ids.note}`)
    expect(refs).not.toContain(`note:${ids.priv}`)
    expect(refs).toContain(`doc:${docEnt.id}#0`)
    expect(refs).toContain(`memo:${ids.spaceMemo}`)
    expect(refs).toContain(`task:${t.id}`)
    expect(refs).toContain(`interaction:${i.id}`)
    expect(
      mine.items.some(
        (x) =>
          x.kind === 'event' && x.text.startsWith('Funding stage: — → seed'),
      ),
    ).toBe(true)
    // the space memo sits at hop 1 (direct tag)
    expect(mine.items.find((x) => x.ref === `memo:${ids.spaceMemo}`)?.hop).toBe(
      1,
    )
    // where it is filed, as a hop-0 fact (D71)
    expect(
      mine.items.find((x) => x.ref === `attr:${spc.id}:path`),
    ).toMatchObject({
      hop: 0,
      kind: 'attribute',
      text: `Filed in: CtxSpace ${tag}`,
    })
    expect(mine.sensitive).toBe(false)
    expect(mine.reveals).toContain(spc.id)

    // ---- as the teammate: their private note appears, nothing else changes ----
    const theirs = await run(teammate.id)
    const theirRefs = theirs.items.map((x) => x.ref)
    expect(theirRefs).toContain(`note:${ids.priv}`)
    expect(theirRefs.filter((r) => r !== `note:${ids.priv}`)).toEqual(refs)

    // ---- deterministic ----
    expect(await run(me.id)).toEqual(mine)

    // ---- lexical lane: task text lifts the matching chunk above p.1 ----
    const lex = await run(me.id, 'PUE improvement pilot')
    const lexRefs = lex.items.map((x) => x.ref)
    expect(lexRefs.indexOf(`doc:${docEnt.id}#2`)).toBeLessThan(
      lexRefs.indexOf(`doc:${docEnt.id}#0`),
    )

    // ---- normalized snapshot: ids → labels, so the fixture is readable ----
    const labels = new Map<string, string>([
      [co.entityId, 'CO'],
      [ids.memo, 'MEMO'],
      [ids.note, 'NOTE'],
      [ids.priv, 'PRIV'],
      [docEnt.id, 'DECK'],
      [spc.id, 'SPACE'],
      [ids.spaceMemo, 'SPACE_MEMO'],
      [t.id, 'TASK'],
      [i.id, 'CALL'],
    ])
    const norm = (s: string) => {
      let out = s
      for (const [id, l] of labels) out = out.split(id).join(l)
      return out
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'UUID')
        .replace(new RegExp(tag, 'g'), 'TAG')
    }
    const shape = mine.items
      .filter((x) => x.kind !== 'mandate' && x.kind !== 'glossary') // workspace-owned, not fixture-owned
      .map((x) => ({
        ref: norm(x.ref),
        kind: x.kind,
        hop: x.hop,
        text: norm(x.text).split('\n')[0],
        score: x.score == null ? null : Number(x.score.toFixed(4)),
      }))
    // The hop-0 floor ties at score 1 and breaks ties by ref, which holds
    // random ids: order it by the normalized ref so the fixture is stable.
    const isFloor = (x: (typeof shape)[number]) =>
      x.hop === 0 && x.kind === 'attribute'
    expect(shape.findIndex((x) => !isFloor(x))).toBe(
      shape.filter(isFloor).length,
    )
    expect([
      ...shape.filter(isFloor).sort((a, b) => (a.ref < b.ref ? -1 : 1)),
      ...shape.filter((x) => !isFloor(x)),
    ]).toMatchSnapshot()
  })

  it('places a record by its full path and ranks the peers of its leaf space only (D71)', async () => {
    const { assembleProgram } = await import('./assemble')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')
    const { PEER_MAX } = await import('../../context/rank')
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { entity, entitySpace, objectDef, space } =
      await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const companies = (
      await db
        .select({ id: objectDef.id })
        .from(objectDef)
        .where(eq(objectDef.slug, 'companies'))
    ).at(0)
    expect(companies).toBeTruthy()
    const aSpace = async (
      name: string,
      parent?: { id: string; path: string },
    ) => {
      const [e] = await db
        .insert(entity)
        .values({ kind: 'space', canonicalName: name })
        .returning({ id: entity.id })
      const slug = `${name.toLowerCase().replace(/\W+/g, '_')}_${tag}`
      const path = parent ? `${parent.path}.${slug}` : slug
      await db
        .insert(space)
        .values({ entityId: e.id, parentId: parent?.id ?? null, slug, path })
      return { id: e.id, path }
    }
    const tech = await aSpace('Spacetech')
    const launch = await aSpace('Launch', tech)
    const small = await aSpace('Small-lift', launch)
    const other = await aSpace('Ground stations', tech)
    const aCompany = async (
      name: string,
      stage: string | null,
      filed: ReadonlyArray<string>,
    ) => {
      const [e] = await db
        .insert(entity)
        .values({
          kind: 'company',
          canonicalName: name,
          objectId: companies!.id,
          values:
            stage === null
              ? { location: 'Pune' }
              : { funding_stage: stage, location: 'Pune' },
        })
        .returning({ id: entity.id })
      for (const spaceId of filed)
        await db
          .insert(entitySpace)
          .values({ entityId: e.id, spaceId, source: 'manual' })
      return e.id
    }
    // Filed in Small-lift and its ancestor Launch: Small-lift is the leaf.
    const seed = await aCompany(`Seedling ${tag}`, 'seed', [
      small.id,
      launch.id,
      other.id,
    ])
    const sameStage = await aCompany(`Rival A ${tag}`, 'seed', [small.id])
    const nextStage = await aCompany(`Rival B ${tag}`, 'series_a', [small.id])
    const noStage = await aCompany(`Rival C ${tag}`, null, [small.id])
    const many = await Promise.all(
      Array.from({ length: PEER_MAX }, (_, n) =>
        aCompany(`Far ${n} ${tag}`, 'public', [small.id]),
      ),
    )
    // In Launch only, above the leaf: never a peer.
    const above = await aCompany(`Launch only ${tag}`, 'seed', [launch.id])
    // A peer in the other leaf space the record is filed in.
    const ground = await aCompany(`Antenna ${tag}`, 'seed', [other.id])

    const result = await Effect.runPromise(
      assembleProgram(
        { entityId: seed },
        { user: { id: me.id }, asOf: ASOF, budgetChars: 20_000 },
      ).pipe(Effect.provide(SimilarLaneEmpty)),
    )
    const positions = result.items.filter((x) => x.ref.endsWith(':path'))
    expect(positions.map((x) => x.text).sort()).toEqual([
      `Filed in: Spacetech › Ground stations`,
      `Filed in: Spacetech › Launch`,
      `Filed in: Spacetech › Launch › Small-lift`,
    ])
    expect(positions.every((x) => x.hop === 0)).toBe(true)

    const peers = result.items
      .filter((x) => x.ref.endsWith(':peer'))
      .map((x) => x.ref)
    expect(peers).toHaveLength(PEER_MAX)
    // Same stage first, the next stage after; the unknown and far are cut.
    expect(peers.slice(0, 2).sort()).toEqual(
      [`attr:${sameStage}:peer`, `attr:${ground}:peer`].sort(),
    )
    expect(peers[2]).toBe(`attr:${nextStage}:peer`)
    expect(peers).not.toContain(`attr:${above}:peer`)
    expect(peers).not.toContain(`attr:${noStage}:peer`)
    // The read ranks and caps as the ranker would: two of the five far
    // peers fill the set, and nothing is left for the ranker to cut.
    expect(
      peers.filter((r) => many.some((id) => r === `attr:${id}:peer`)),
    ).toHaveLength(2)
    expect(result.dropped.some((d) => d.reason === 'peer_cap')).toBe(false)
    expect(
      result.items.find((x) => x.ref === `attr:${sameStage}:peer`)?.text,
    ).toBe(
      `Peer in Small-lift: Rival A ${tag} — Funding stage: Seed · Location: Pune`,
    )
  })

  it('seeds a document with its own chunks first', async () => {
    const { assembleProgram } = await import('./assemble')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { chunk, document, entity, link } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const [co] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `DocCo ${tag}` })
      .returning({ id: entity.id })
    const [doc] = await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: `memo-${tag}.pdf` })
      .returning({ id: entity.id })
    // Exempt from the one-writer rule: a fixture with text already read.
    await db.insert(document).values({
      entityId: doc.id,
      filename: `memo-${tag}.pdf`,
      kind: 'deck',
      sourceClass: 'manual',
      extractionStatus: 'done',
      createdAt: new Date('2026-08-20T00:00:00Z'),
    })
    await db.insert(chunk).values(
      Array.from({ length: 12 }, (_, idx) => ({
        entityId: doc.id,
        sourceKind: 'document' as const,
        idx,
        text: idx === 7 ? 'Hydrogen electrolyser margins.' : `Page ${idx}.`,
      })),
    )
    await db.insert(link).values({
      fromEntityId: doc.id,
      toEntityId: co.id,
      relation: 'tagged_in',
      source: 'manual',
    })
    const assemble = (taskText?: string) =>
      Effect.runPromise(
        assembleProgram(
          { entityId: doc.id },
          { user: { id: me.id }, asOf: ASOF, budgetChars: 8000, taskText },
        ).pipe(Effect.provide(SimilarLaneEmpty)),
      )
    const plain = await assemble()
    const chunks = plain.items.filter((x) => x.kind === 'doc_chunk')
    expect(chunks.map((x) => x.ref)).toEqual(
      Array.from({ length: 12 }, (_, i) => `doc:${doc.id}#${i}`),
    )
    // Before anything the walk reached.
    const firstOther = plain.items.findIndex(
      (x) => x.kind !== 'doc_chunk' && x.hop !== 'standing',
    )
    expect(firstOther).toBeGreaterThan(
      plain.items.findIndex((x) => x.ref === `doc:${doc.id}#11`),
    )
    expect(plain.items.some((x) => x.text === `company: DocCo ${tag}`)).toBe(
      true,
    )
    // The task text lifts its page to the front.
    const asked = await assemble('electrolyser margins')
    expect(asked.items.find((x) => x.kind === 'doc_chunk')?.ref).toBe(
      `doc:${doc.id}#7`,
    )
  })

  it('takes asOf as an input: the same data at two clocks ranks by the clock it was handed', async () => {
    const { assembleProgram } = await import('./assemble')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { entity, link, note } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const [co] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `AsOfCo ${tag}` })
      .returning({ id: entity.id })
    const [n] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: `AsOf note ${tag}` })
      .returning({ id: entity.id })
    await db.insert(note).values({
      entityId: n.id,
      title: `AsOf note ${tag}`,
      bodyMd: 'Dated once, read at two clocks.',
      kind: 'note',
      authorId: me.id,
      visibility: 'shared',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    })
    await db.insert(link).values({
      fromEntityId: n.id,
      toEntityId: co.id,
      relation: 'mentions',
      source: 'manual',
    })

    const at = (asOf: string) =>
      Effect.runPromise(
        assembleProgram(
          { entityId: co.id },
          { user: { id: me.id }, asOf, budgetChars: 8000 },
        ).pipe(Effect.provide(SimilarLaneEmpty)),
      )
    const scoreAt = async (asOf: string) =>
      (await at(asOf)).items.find((x) => x.ref === `note:${n.id}`)?.score
    const near = await scoreAt('2026-09-02T00:00:00Z')
    const far = await scoreAt('2027-09-02T00:00:00Z')
    expect(near).toBeTypeOf('number')
    expect(far).toBeTypeOf('number')
    // Recency decays against the clock it was handed, not the wall clock.
    expect(Number(near)).toBeGreaterThan(Number(far))
    // And the same clock is the same answer.
    expect(await at('2026-09-02T00:00:00Z')).toEqual(
      await at('2026-09-02T00:00:00Z'),
    )
  })

  it("reaches a person's companies through `references` at full edge weight", async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues } = await import('../attributes/values')
    const { assembleProgram } = await import('./assemble')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')
    const { DEFAULT_WEIGHTS } = await import('../../context/rank')
    const { ref } = await import('../../context/ref')
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const co = (
      await resolveEntity({
        kind: 'company',
        name: `WorksAt ${tag}`,
        keys: { domain: `worksat-${tag}.com` },
        source: { class: 'manual' },
      })
    ).entityId
    const person = (
      await resolveEntity({
        kind: 'person',
        name: `Worker ${tag}`,
        source: { class: 'manual' },
      })
    ).entityId
    await setValues({
      entityId: person,
      patch: { companies: [co] },
      actor: { type: 'user', id: me.id },
    })
    const assemble = (entityId: string) =>
      Effect.runPromise(
        assembleProgram(
          { entityId },
          { user: { id: me.id }, asOf: ASOF, budgetChars: 8000 },
        ).pipe(Effect.provide(SimilarLaneEmpty)),
      )

    // From the company: the person, one hop out over `references`.
    const fromCompany = (await assemble(co)).items.find(
      (x) => x.ref === ref.attr(person, 'companies'),
    )
    expect(fromCompany).toMatchObject({ hop: 1, kind: 'attribute' })
    // Named by the company's own inverse attribute, not the person's. (D69)
    expect(fromCompany?.text).toBe(`Team: Worker ${tag} (person)`)
    expect(fromCompany?.structural).toBeCloseTo(
      DEFAULT_WEIGHTS.hop[1] *
        DEFAULT_WEIGHTS.edge.references *
        DEFAULT_WEIGHTS.prior.attribute,
    )
    expect(DEFAULT_WEIGHTS.edge.references).toBe(1)

    // From the person: a fact about them, at hop 0.
    const fromPerson = (await assemble(person)).items.find(
      (x) => x.ref === ref.attr(person, 'companies'),
    )
    expect(fromPerson).toMatchObject({ hop: 0, kind: 'attribute' })
    expect(fromPerson?.text).toContain(`WorksAt ${tag}`)
  })

  it('refuses with ContextLeak when a lane hands back a note canRead would refuse', async () => {
    const { assembleProgram } = await import('./assemble')
    const { SimilarLane } = await import('../../context/similar-lane')
    const { ref } = await import('../../context/ref')
    const { Effect, Exit, Layer } = await import('effect')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const [co] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `LeakCo ${tag}` })
      .returning({ id: entity.id })

    // A lane that lost its canRead filter: a teammate's private note.
    const privateId = randomUUID()
    const lost: SimilarCandidate = {
      ref: ref.note(privateId),
      kind: 'note',
      text: 'Similar judgment — note on Elsewhere: not yours',
      entityIds: [privateId],
      at: null,
      hop: 'similar',
      similarity: 0.9,
      noteRow: {
        entityId: privateId,
        visibility: 'private',
        authorId: `someone-else-${tag}`,
      },
    }
    const leaky = Layer.succeed(
      SimilarLane,
      SimilarLane.of({
        candidates: () => Effect.succeed([lost]),
        pinned: () => Effect.succeed(true),
      }),
    )
    const exit = await Effect.runPromiseExit(
      assembleProgram(
        { entityId: co.id },
        { user: { id: me.id }, asOf: ASOF, budgetChars: 8000, similar: true },
      ).pipe(Effect.provide(leaky)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('ContextLeak')
  })

  it('ranks a superseded deck below its successor, and keeps both (D59)', async () => {
    const { assembleProgram } = await import('./assemble')
    const { markNewerVersionProgram } = await import('../links/supersedes')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')
    const { DEFAULT_WEIGHTS } = await import('../../context/rank')
    const { ref } = await import('../../context/ref')
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { chunk, document, entity, link } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const [co] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `VersionCo ${tag}` })
      .returning({ id: entity.id })
    const deck = async (name: string) => {
      const [e] = await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: name })
        .returning({ id: entity.id })
      // Exempt from the one-writer rule: a fixture with text already read.
      await db.insert(document).values({
        entityId: e.id,
        filename: name,
        kind: 'deck',
        sourceClass: 'manual',
        extractionStatus: 'done',
        createdAt: new Date('2026-08-20T00:00:00Z'),
      })
      await db.insert(chunk).values({
        entityId: e.id,
        sourceKind: 'document',
        idx: 0,
        text: `${name}: the round.`,
      })
      await db.insert(link).values({
        fromEntityId: e.id,
        toEntityId: co.id,
        relation: 'tagged_in',
        source: 'manual',
      })
      return e.id
    }
    const v2 = await deck('deck-v2.pdf')
    const v3 = await deck('deck-v3.pdf')

    await Effect.runPromise(
      markNewerVersionProgram({ newerId: v3, olderId: v2, actorId: me.id }),
    )
    const result = await Effect.runPromise(
      assembleProgram(
        { entityId: co.id },
        { user: { id: me.id }, asOf: ASOF, budgetChars: 8000 },
      ).pipe(Effect.provide(SimilarLaneEmpty)),
    )
    const refs = result.items.map((x) => x.ref)
    expect(refs).toContain(ref.doc(v2, 0))
    expect(refs.indexOf(ref.doc(v3, 0))).toBeLessThan(
      refs.indexOf(ref.doc(v2, 0)),
    )
    const score = (r: string) =>
      result.items.find((x) => x.ref === r)?.structural ?? 0
    expect(score(ref.doc(v2, 0))).toBeCloseTo(
      score(ref.doc(v3, 0)) * DEFAULT_WEIGHTS.superseded,
      9,
    )
  })

  it('excludeSensitive leaves stamped chunks out in SQL, the seed’s and a neighbour’s alike', async () => {
    const { assembleProgram } = await import('./assemble')
    const { SimilarLane } = await import('../../context/similar-lane')
    const { ref } = await import('../../context/ref')
    const { Effect, Layer } = await import('effect')
    const { db } = await import('@spaces/db')
    const { chunk, document, entity, link } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const [co] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `PlainCo ${tag}` })
      .returning({ id: entity.id })
    const deck = async (name: string, stamped: boolean) => {
      const [e] = await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: name })
        .returning({ id: entity.id })
      // Exempt from the one-writer rule: a fixture with text already read.
      await db.insert(document).values({
        entityId: e.id,
        filename: name,
        kind: 'deck',
        sourceClass: 'manual',
        extractionStatus: 'done',
        createdAt: new Date('2026-08-20T00:00:00Z'),
      })
      // A stamped fixture row: what the raise leaves behind.
      await db.insert(chunk).values(
        [0, 1].map((idx) => ({
          entityId: e.id,
          sourceKind: 'document' as const,
          idx,
          text: `${name} page ${String(idx)}.`,
          sensitive: stamped,
        })),
      )
      await db.insert(link).values({
        fromEntityId: e.id,
        toEntityId: co.id,
        relation: 'tagged_in',
        source: 'manual',
      })
      return e.id
    }
    const plain = await deck(`plain-${tag}.pdf`, false)
    const secret = await deck(`dataroom-${tag}.pdf`, true)

    const asked: Array<boolean | undefined> = []
    const lane = Layer.succeed(
      SimilarLane,
      SimilarLane.of({
        candidates: (input) => {
          asked.push(input.excludeSensitive)
          return Effect.succeed([])
        },
        pinned: () => Effect.succeed(true),
      }),
    )
    const run = (entityId: string, excludeSensitive?: boolean) =>
      Effect.runPromise(
        assembleProgram(
          { entityId },
          {
            user: { id: me.id },
            asOf: ASOF,
            budgetChars: 8000,
            similar: true,
            ...(excludeSensitive === undefined ? {} : { excludeSensitive }),
          },
        ).pipe(Effect.provide(lane)),
      )

    const all = await run(co.id)
    const allRefs = all.items.map((x) => x.ref)
    expect(allRefs).toContain(ref.doc(secret, 0))
    expect(allRefs).toContain(ref.doc(plain, 0))

    const cloud = await run(co.id, true)
    const cloudRefs = cloud.items.map((x) => x.ref)
    expect(cloudRefs).toContain(ref.doc(plain, 0))
    expect(cloudRefs.filter((r) => r.includes(secret))).toEqual([])
    expect(cloud.reveals).not.toContain(secret)
    // The judgment-memory lane is asked to leave them out too.
    expect(asked).toEqual([undefined, true])

    // Off, the option changes nothing.
    expect(await run(co.id, false)).toEqual(all)

    // A document seed's own stamped chunks go the same way.
    const seeded = await run(secret, true)
    expect(seeded.items.filter((x) => x.kind === 'doc_chunk')).toEqual([])
  })

  it('refuses with ContextLeak when a chunk stamped sensitive reaches an excludeSensitive output', async () => {
    const { sensitiveChecked } = await import('./spaces')
    const { ref } = await import('../../context/ref')
    const { Effect, Exit } = await import('effect')
    const { db } = await import('@spaces/db')
    const { chunk, entity } = await import('@spaces/db/schema')

    const [doc] = await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: `leak-${tag}.pdf` })
      .returning({ id: entity.id })
    const [deal] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `LeakDeal ${tag}` })
      .returning({ id: entity.id })
    // Stamped fixture rows: a fetch that lost its filter would hand them on.
    await db.insert(chunk).values([
      {
        entityId: doc.id,
        sourceKind: 'document',
        idx: 0,
        text: 'plain',
        sensitive: false,
      },
      {
        entityId: doc.id,
        sourceKind: 'document',
        idx: 1,
        text: 'secret',
        sensitive: true,
      },
      {
        entityId: deal.id,
        sourceKind: 'attribute',
        sourceKey: 'close_reason',
        idx: 0,
        text: 'passed: secret',
        sensitive: true,
      },
    ])
    const check = (items: Array<{ ref: string; hop: 0 | 'similar' }>) =>
      Effect.runPromiseExit(sensitiveChecked(items))

    expect(
      Exit.isSuccess(await check([{ ref: ref.doc(doc.id, 0), hop: 0 }])),
    ).toBe(true)
    const leak = await check([
      { ref: ref.doc(doc.id, 0), hop: 0 },
      { ref: ref.doc(doc.id, 1), hop: 0 },
    ])
    expect(Exit.isFailure(leak)).toBe(true)
    expect(JSON.stringify(leak)).toContain('ContextLeak')
    expect(JSON.stringify(leak)).toContain(ref.doc(doc.id, 1))
    const similar = await check([
      { ref: ref.attr(deal.id, 'close_reason'), hop: 'similar' },
    ])
    expect(JSON.stringify(similar)).toContain('ContextLeak')
    // The same attribute reached by the walk is not a chunk.
    expect(
      Exit.isSuccess(
        await check([{ ref: ref.attr(deal.id, 'close_reason'), hop: 0 }]),
      ),
    ).toBe(true)
  })
})
