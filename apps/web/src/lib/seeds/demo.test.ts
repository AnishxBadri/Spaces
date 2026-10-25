import { Effect } from 'effect'
import { eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, space, workspace } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  demoIdsOf,
  demoSummaryProgram,
  removeDemoDataProgram,
  seedDemoData,
} from './demo'

/**
 * Demo data is removable in one step: the seed records exactly the
 * entities it births at `workspace.settings.demo`, and removal deletes those
 * through the entity delete program — never a space the starter taxonomy
 * already held, never a record added since.
 */

const run = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(effect)

const recorded = async () => {
  const row = (
    await db
      .select({ settings: workspace.settings })
      .from(workspace)
      .where(eq(workspace.id, 1))
  ).at(0)
  return row === undefined ? null : demoIdsOf(row.settings)
}

describe('demo data', () => {
  it('records its ids, and Remove deletes exactly those', async () => {
    const before = await db.select({ id: space.entityId }).from(space)

    expect(await seedDemoData(FIXTURE_ACTOR.id)).toEqual({ seeded: true })
    const ids = (await recorded()) ?? []
    // Starter-taxonomy spaces the demo reused are not the demo's.
    for (const s of before) expect(ids).not.toContain(s.id)

    const demoCompanies = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.kind, 'company'))
    expect(demoCompanies).toHaveLength(3)
    for (const c of demoCompanies) expect(ids).toContain(c.id)

    const summary = await run(demoSummaryProgram())
    expect(summary?.byKind.company).toBe(3)
    expect(summary?.byKind.person).toBe(1)
    expect(summary?.byKind.term).toBe(3)
    expect(summary?.byKind.note).toBe(1)
    expect(summary?.total).toBe(ids.length)

    const since = await resolveEntity({
      kind: 'company',
      name: 'Orbital',
      keys: { domain: 'orbital.example' },
      source: { class: 'manual' },
      createdBy: FIXTURE_ACTOR.id,
    })

    const outcome = await run(removeDemoDataProgram())
    expect(outcome).toEqual({ removed: ids.length, kept: 0 })

    expect(
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(inArray(entity.id, ids)),
    ).toEqual([])
    const left = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.kind, 'company'))
    expect(left).toEqual([{ id: since.entityId }])
    const spaces = await db.select({ id: space.entityId }).from(space)
    expect(spaces.map((s) => s.id).sort()).toEqual(
      before.map((s) => s.id).sort(),
    )

    // The key is cleared, so General's row is absent.
    expect(await recorded()).toBeNull()
    expect(await run(demoSummaryProgram())).toBeNull()
  })

  it('has no summary when no demo was loaded', async () => {
    expect(await run(demoSummaryProgram())).toBeNull()
    expect(await run(removeDemoDataProgram())).toEqual({
      removed: 0,
      kept: 0,
    })
  })
})
