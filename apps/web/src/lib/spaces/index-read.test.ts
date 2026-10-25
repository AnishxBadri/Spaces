import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, entitySpace } from '@spaces/db/schema'
import {
  archiveSpaceProgram,
  restoreSpaceProgram,
} from '@spaces/core/writes/entities/space'
import { createSpaceRow } from '#/lib/server/shared'
import { localDay } from '#/lib/records/readout-format'
import { spacesIndexProgram } from './read'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * The spaces index: every live row carries its last filed day, rolled
 * up over its live subtree, and the archive heads come back for the fold.
 */

const me = FIXTURE_ACTOR.id
let n = 0
const tag = () => `${String(++n)}${Math.random().toString(36).slice(2, 6)}`

const aSpace = (name: string, parentId: string | null = null) =>
  createSpaceRow(`${name} ${tag()}`, parentId, me)

async function fileOn(spaceId: string, at: string): Promise<void> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Co ${tag()}` })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(entitySpace).values({
    entityId: row.id,
    spaceId,
    source: 'manual',
    createdAt: new Date(at),
  })
}

const index = () => Effect.runPromise(spacesIndexProgram(me))

const rowOf = async (id: string) => {
  const r = (await index()).spaces.find((s) => s.id === id)
  if (!r) throw new Error(`no index row ${id}`)
  return r
}

describe('spacesIndexProgram', () => {
  it('gives each row the newest filing in its subtree, or null', async () => {
    const top = await aSpace('Proptech')
    const child = await aSpace('Property ops', top)
    const quiet = await aSpace('Real estate')
    await fileOn(top, '2026-09-30T12:00:00Z')
    await fileOn(child, '2026-10-06T12:00:00Z')

    expect((await rowOf(top)).lastFiled).toBe(
      localDay(new Date('2026-10-06T12:00:00Z')),
    )
    expect((await rowOf(child)).lastFiled).toBe(
      localDay(new Date('2026-10-06T12:00:00Z')),
    )
    expect((await rowOf(quiet)).lastFiled).toBeNull()
  })

  it('leaves an archived subspace out of its parent’s last filed', async () => {
    const top = await aSpace('Fintech')
    const child = await aSpace('Lending infra', top)
    await fileOn(top, '2026-09-02T12:00:00Z')
    await fileOn(child, '2026-10-03T12:00:00Z')
    await Effect.runPromise(archiveSpaceProgram(me, child))

    expect((await rowOf(top)).lastFiled).toBe(
      localDay(new Date('2026-09-02T12:00:00Z')),
    )
  })

  it('lists archive heads only, with what they hold, until restored', async () => {
    const top = await aSpace('Climate')
    const child = await aSpace('Carbon removal', top)
    await aSpace('Grid', child)
    await Effect.runPromise(archiveSpaceProgram(me, child))

    const topName = (
      await db
        .select({ name: entity.canonicalName })
        .from(entity)
        .where(eq(entity.id, top))
    ).at(0)?.name

    if (topName === undefined) throw new Error(`no entity ${top}`)

    // Only the head: the grandchild archived with it is not a row of its own.
    const archived = (await index()).archived.filter(
      (a) => a.within !== null && a.within.startsWith(topName),
    )
    expect(archived).toHaveLength(1)
    expect(archived.at(0)).toMatchObject({
      id: child,
      within: topName,
      spaces: 2,
    })
    expect((await index()).spaces.map((s) => s.id)).not.toContain(child)

    await Effect.runPromise(restoreSpaceProgram(me, child))
    const after = await index()
    expect(after.archived.map((a) => a.id)).not.toContain(child)
    expect(after.spaces.map((s) => s.id)).toContain(child)
  })
})
