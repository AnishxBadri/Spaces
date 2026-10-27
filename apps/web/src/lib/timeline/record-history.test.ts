import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * What the History tab's figure lane reads off the timeline: each macro's
 * facts from `activity.meta` and its object (a money figure, the attributes
 * an enrichment wrote, a filed document's name, the space's path, the merged
 * record's name); a burst's prior value; and which interactions this record
 * holds by its own edge, which `File on a deal…` adds and `Unlink` takes
 * away. Dynamic imports: the harness points `DATABASE_URL` at this worker's
 * database before `@spaces/db` loads.
 */
describe('the record timeline’s History facts', () => {
  it('reads each macro’s figure facts and a burst’s prior value', async () => {
    const { db } = await import('@spaces/db')
    const { attributeEvent, entity, space } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { isNotNull } = await import('drizzle-orm')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { recordTimelineProgram } = await import('./record')

    const acme = (
      await resolveEntity({
        kind: 'company',
        name: 'History Acme',
        keys: { domain: 'history-acme.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const loser = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: 'Exponent Labs' })
        .returning({ id: entity.id })
    ).at(0)
    if (!loser) throw new Error('no loser')
    // A seeded subspace, so the path climbs through its parent.
    const child = (
      await db
        .select({ id: space.entityId, parentId: space.parentId })
        .from(space)
        .where(isNotNull(space.parentId))
        .limit(1)
    ).at(0)
    if (!child?.parentId) throw new Error('no seeded subspace')
    const names = new Map(
      (
        await db
          .select({ id: entity.id, name: entity.canonicalName })
          .from(entity)
      ).map((r) => [r.id, r.name]),
    )

    const at = (day: number) => new Date(Date.UTC(2026, 9, day, 10))
    await db.insert(activity).values([
      {
        actorId: FIXTURE_ACTOR.id,
        verb: 'mark.added',
        subjectEntityId: acme,
        meta: { amount: 4_500_000, currency: 'USD' },
        at: at(1),
      },
      {
        verb: 'entity.enriched',
        subjectEntityId: acme,
        meta: { fields: 6 },
        at: at(2),
      },
      {
        actorId: FIXTURE_ACTOR.id,
        verb: 'document.filed',
        subjectEntityId: acme,
        meta: { filename: 'Q3 board deck.pdf', kind: 'deck', targets: 1 },
        at: at(3),
      },
      {
        actorId: FIXTURE_ACTOR.id,
        verb: 'space.tagged',
        subjectEntityId: acme,
        objectEntityId: child.id,
        at: at(4),
      },
      {
        actorId: FIXTURE_ACTOR.id,
        verb: 'entity.merged',
        subjectEntityId: acme,
        objectEntityId: loser.id,
        at: at(5),
      },
    ])
    await db.insert(attributeEvent).values({
      entityId: acme,
      attrSlug: 'team_size',
      from: 90,
      to: 120,
      actorType: 'user',
      actorId: FIXTURE_ACTOR.id,
      at: at(6),
    })

    const items = await Effect.runPromise(
      recordTimelineProgram(acme, { id: FIXTURE_ACTOR.id }),
    )
    const factsOf = (verb: string) => {
      const row = items.find((i) => i.type === 'macro' && i.verb === verb)
      if (row?.type !== 'macro') throw new Error(`no ${verb}`)
      return row.facts
    }
    expect(factsOf('mark.added')).toMatchObject({
      amount: 4_500_000,
      currency: 'USD',
    })
    expect(factsOf('entity.enriched').fields).toBe(6)
    expect(factsOf('document.filed').document).toBe('Q3 board deck.pdf')
    expect(factsOf('space.tagged').space).toBe(
      `${names.get(child.parentId)} › ${names.get(child.id)}`,
    )
    expect(factsOf('entity.merged').merged).toBe('Exponent Labs')
    const burst = items.find(
      (i) =>
        i.type === 'attrs' && i.changes.some((c) => c.slug === 'team_size'),
    )
    if (burst?.type !== 'attrs') throw new Error('no burst')
    expect(burst.changes.at(0)).toMatchObject({ from: 90, to: 120 })
  })

  it('files an interaction on a deal and unlinks it, the edge marking it linked', async () => {
    const { db } = await import('@spaces/db')
    const { entity, interaction, interactionEntity } =
      await import('@spaces/db/schema')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { recordTimelineProgram } = await import('./record')
    const {
      fileInteractionOnEntityProgram,
      unlinkInteractionFromEntityProgram,
    } = await import('#/lib/interactions/file-on')

    const acme = (
      await resolveEntity({
        kind: 'company',
        name: 'Edge Acme',
        keys: { domain: 'edge-acme.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const deal = (
      await db
        .insert(entity)
        .values({ kind: 'deal', canonicalName: 'Edge Acme — Seed' })
        .returning({ id: entity.id })
    ).at(0)
    if (!deal) throw new Error('no deal')
    const call = (
      await db
        .insert(interaction)
        .values({
          kind: 'call',
          subject: 'Intro call',
          occurredAt: new Date('2026-10-01T10:00:00.000Z'),
        })
        .returning({ id: interaction.id })
    ).at(0)
    if (!call) throw new Error('no call')
    await db
      .insert(interactionEntity)
      .values({ interactionId: call.id, entityId: acme })

    const linkedOn = async (entityId: string) => {
      const row = (
        await Effect.runPromise(
          recordTimelineProgram(entityId, { id: FIXTURE_ACTOR.id }),
        )
      ).find((i) => i.id === call.id)
      return row?.type === 'interaction' ? row.linked : null
    }
    expect(await linkedOn(acme)).toBe(true)
    expect(await linkedOn(deal.id)).toBeNull()

    expect(
      await Effect.runPromise(fileInteractionOnEntityProgram(call.id, deal.id)),
    ).toEqual({ filed: true })
    expect(
      await Effect.runPromise(fileInteractionOnEntityProgram(call.id, deal.id)),
    ).toEqual({ filed: false })
    expect(await linkedOn(deal.id)).toBe(true)

    expect(
      await Effect.runPromise(
        unlinkInteractionFromEntityProgram(call.id, deal.id),
      ),
    ).toEqual({ unlinked: true })
    expect(await linkedOn(deal.id)).toBeNull()
    expect(await linkedOn(acme)).toBe(true)
  })
})
