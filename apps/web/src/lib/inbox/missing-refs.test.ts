import { describe, expect, it } from 'vitest'

/**
 * The one ref resolver's two app consumers (SPA-119): a suggestion whose
 * cited record was deleted still lists on /inbox, and an accepted one still
 * draws on the record timeline — each citation `missing`, neither consumer
 * failing. The resolver itself and the rest of its tests are core's since
 * SPA-182 (`packages/core/src/writes/context/names.test.ts`); this half
 * stayed because both consumers are apps/web's. On this worker's test
 * database, truncated and reseeded before the file was imported (SPA-145).
 */
describe('resolveRefs — deleted targets, in the app', () => {
  it('reaches /inbox and the record timeline as missing — neither consumer fails', async () => {
    const { Effect } = await import('effect')
    const { eq } = await import('drizzle-orm')
    const { db } = await import('@spaces/db')
    const schema = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { MISSING_LABEL } = await import('@spaces/core/writes/context/names')
    const { ref } = await import('@spaces/core/context/ref')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { proposeProgram, acceptProgram } = await import('#/lib/ai/propose')
    const { listInboxProgram } = await import('#/lib/inbox/queue')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')

    const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!me) throw new Error('the test seed has no user')

    const company = (
      await resolveEntity({
        kind: 'company',
        name: 'Cited Robotics',
        keys: { domain: 'cited-robotics.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const source = (
      await db
        .insert(schema.entity)
        .values({ kind: 'company', canonicalName: 'Soon Gone' })
        .returning({ id: schema.entity.id })
    ).at(0)?.id
    if (!source) throw new Error('entity insert returned nothing')
    const cited = [ref.attr(source, 'location'), ref.note(source)]

    const open = await Effect.runPromise(
      proposeProgram({
        entityId: company,
        kind: 'attribute_patch',
        payload: {
          founded_year: { value: 2019, refs: cited, confidence: 0.8 },
        },
        rationale: 'read it off a record that will be deleted',
        proposedBy: { type: 'system' },
      }),
    )
    const accepted = await Effect.runPromise(
      proposeProgram({
        entityId: company,
        kind: 'attribute_patch',
        payload: {
          location: { value: 'Berlin', refs: cited, confidence: 0.8 },
        },
        rationale: 'accepted, so its refs reach attribute_event',
        proposedBy: { type: 'system' },
      }),
    )
    await Effect.runPromise(
      acceptProgram(accepted.id, { type: 'user', id: me.id }),
    )
    await db.delete(schema.entity).where(eq(schema.entity.id, source))

    const missing = cited.map((r) => ({
      ref: r,
      entityId: null,
      label: MISSING_LABEL,
      missing: true,
    }))

    const rows = await Effect.runPromise(listInboxProgram())
    const card = rows.find((r) => r.kind === 'suggestion' && r.id === company)
    if (card?.kind !== 'suggestion') throw new Error('no suggestion card')
    expect(card.suggestions.find((s) => s.id === open.id)?.citations).toEqual(
      missing,
    )

    const timeline = await Effect.runPromise(recordTimelineProgram(company))
    const burst = timeline.find(
      (i) => i.type === 'attrs' && i.source === 'suggestion',
    )
    if (burst?.type !== 'attrs') throw new Error('no suggestion burst')
    expect(burst.changes).toEqual([
      { slug: 'location', to: 'Berlin', citations: missing },
    ])
  })
})
