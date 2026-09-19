import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupTestEntities } from '#/lib/entities/test-helpers'

const hasDb = Boolean(process.env.DATABASE_URL)
const ASOF = '2026-09-10T00:00:00Z'

/**
 * Integration test on the dev database: builds a company with everything
 * the walk can reach — attributes, alias, history, memo, shared note, a
 * teammate's private note, a deck with chunks, a space with a memo, a task,
 * an interaction — assembles it as two users, and snapshots the shape.
 */
describe.skipIf(!hasDb)('assembleProgram', () => {
  const tag = randomUUID().slice(0, 8)
  const ids: Record<string, string> = {}
  let teammateId = ''

  afterAll(async () => {
    const { db } = await import('#/db')
    const { documentChunk, document } = await import('#/db/schema')
    const { task, taskEntity } = await import('#/db/schema/tasks')
    const { interaction, interactionEntity } =
      await import('#/db/schema/interactions')
    const { user } = await import('#/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    if (ids.doc) {
      await db
        .delete(documentChunk)
        .where(eq(documentChunk.documentId, ids.doc))
      await db.delete(document).where(eq(document.entityId, ids.doc))
    }
    if (ids.task) {
      await db.delete(taskEntity).where(eq(taskEntity.taskId, ids.task))
      await db.delete(task).where(eq(task.id, ids.task))
    }
    if (ids.interaction) {
      await db
        .delete(interactionEntity)
        .where(eq(interactionEntity.interactionId, ids.interaction))
      await db.delete(interaction).where(eq(interaction.id, ids.interaction))
    }
    await cleanupTestEntities([`^Ctx(Co|Note|Memo|Doc|Space|Priv) ${tag}`])
    if (teammateId) await db.delete(user).where(eq(user.id, teammateId))
  })

  it('assembles the record for two users, deterministically', async () => {
    const { resolveEntity } = await import('#/lib/entities/resolve')
    const { assembleProgram } = await import('./assemble')
    const { Effect } = await import('effect')
    const { db } = await import('#/db')
    const {
      attributeEvent,
      document,
      documentChunk,
      entity,
      entitySpace,
      link,
      note,
      space,
    } = await import('#/db/schema')
    const { task, taskEntity } = await import('#/db/schema/tasks')
    const { interaction, interactionEntity } =
      await import('#/db/schema/interactions')
    const { user } = await import('#/db/schema/auth')
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
    teammateId = teammate.id

    const co = await resolveEntity({
      kind: 'company',
      name: `CtxCo ${tag}`,
      keys: { domain: `ctxco-${tag}.com` },
      source: 'manual',
    })
    ids.co = co.entityId
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
    await db.insert(document).values({
      entityId: docEnt.id,
      filename: 'seed-deck.pdf',
      kind: 'deck',
      origin: 'upload',
      extractionStatus: 'done',
      createdAt: new Date('2026-08-20T00:00:00Z'),
    })
    await db
      .insert(documentChunk)
      .values(
        [
          'Problem: edge DCs run hot.',
          'Team: Priya Rao, ex-Tata Power.',
          'Pilot: 40% PUE improvement.',
        ].map((text, idx) => ({ documentId: docEnt.id, idx, text })),
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
        ),
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
    expect(shape).toMatchSnapshot()
  })
})
