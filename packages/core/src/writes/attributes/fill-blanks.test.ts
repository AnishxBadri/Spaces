import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attributeEvent, entity, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { resolveEntity } from '../entities/resolve'
import { setValuesEffect } from './values'
import type { Actor } from './values'

/**
 * `setValuesEffect`'s fill-blanks mode (sdk-9), the lane `Facts.fill` runs
 * on: blank is decided after the entity row lock, so two fills racing for
 * one blank slug cannot both see it blank. The port-level behaviour —
 * provenance, receipts, the JobError mapping — is `ports/facts.test.ts`.
 */

const anIntegration = async (capabilityId: string) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row.id
}

const aCompany = async (name: string) =>
  (await resolveEntity({ kind: 'company', name, source: { class: 'manual' } }))
    .entityId

const fill = (entityId: string, patch: Record<string, unknown>, actor: Actor) =>
  Effect.runPromise(
    setValuesEffect({
      entityId,
      patch,
      actor,
      source: 'enrichment',
      fillBlanks: true,
    }),
  )

const eventsFor = (entityId: string, slug: string) =>
  db
    .select()
    .from(attributeEvent)
    .where(
      and(
        eq(attributeEvent.entityId, entityId),
        eq(attributeEvent.attrSlug, slug),
      ),
    )

const valuesOf = async (entityId: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)?.values

describe('setValuesEffect, fill-blanks mode', () => {
  it('two concurrent fills of one blank slug: one write, one conflict', async () => {
    const a = await anIntegration('fill-race-a')
    const b = await anIntegration('fill-race-b')
    // Several records, so the race is run more than once.
    for (let i = 0; i < 5; i++) {
      const co = await aCompany(`Race Co ${i}`)
      const results = await Promise.all([
        fill(co, { founded_year: 2001 }, { type: 'integration', id: a }),
        fill(co, { founded_year: 2002 }, { type: 'integration', id: b }),
      ])

      const written = results.filter((r) => r.changed.includes('founded_year'))
      const refused = results.flatMap((r) => r.conflicts)
      expect(written).toHaveLength(1)
      expect(refused).toHaveLength(1)

      const events = await eventsFor(co, 'founded_year')
      expect(events).toHaveLength(1)
      const held = (await valuesOf(co))?.founded_year
      // The conflict names the winner's value as the one held.
      expect(refused.at(0)).toMatchObject({
        slug: 'founded_year',
        existing: held,
      })
      expect(events.at(0)?.to).toEqual(held)
    }
  })

  it('a patch write is untouched by the mode: no conflicts, overwrite as before', async () => {
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const row = await anIntegration('fill-patch')
    const co = await aCompany('Patch Co')
    await fill(co, { founded_year: 2010 }, { type: 'integration', id: row })
    const result = await Effect.runPromise(
      setValuesEffect({
        entityId: co,
        patch: { founded_year: 2011 },
        actor: { type: 'user', id: actor.id },
      }),
    )
    expect(result.conflicts).toEqual([])
    expect(result.changed).toEqual(['founded_year'])
    expect((await valuesOf(co))?.founded_year).toBe(2011)
  })

  it('refuses a value the system wrote, and one with no event at all', async () => {
    const row = await anIntegration('fill-system')
    const co = await aCompany('Seeded Co')
    await Effect.runPromise(
      setValuesEffect({
        entityId: co,
        patch: { founded_year: 1999 },
        actor: { type: 'system' },
        source: 'seed',
      }),
    )
    // A value that reached the blob with no event names no writer.
    const held = await valuesOf(co)
    await db
      .update(entity)
      .set({ values: { ...held, location: 'Pune' } })
      .where(eq(entity.id, co))

    const result = await fill(
      co,
      { founded_year: 2000, location: 'Delhi' },
      { type: 'integration', id: row },
    )
    expect(result.changed).toEqual([])
    expect(result.conflicts).toEqual([
      { slug: 'founded_year', existing: 1999, proposed: 2000 },
      { slug: 'location', existing: 'Pune', proposed: 'Delhi' },
    ])
    expect(await eventsFor(co, 'location')).toHaveLength(0)
  })
})
