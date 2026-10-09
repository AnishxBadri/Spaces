import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { objectDef, view } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { objectIdForKind } from '@spaces/core/writes/attributes/objects'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { pinnedViewsProgram } from './pinned'

/**
 * The sidebar's pinned-view read: of the ids asked about, only the views the
 * caller may open come back, each with its object's slug — so a pin on a
 * deleted view or on someone else's private view is never drawn, and the
 * sidebar prunes it.
 */

const me = { id: FIXTURE_ACTOR.id }

async function mkView(
  over: Partial<typeof view.$inferInsert> & { name: string },
): Promise<string> {
  const companies = await Effect.runPromise(objectIdForKind('company'))
  const row = (
    await db
      .insert(view)
      .values({
        surface: 'object',
        objectId: companies,
        filter: [],
        visibility: 'shared',
        createdBy: me.id,
        ...over,
      })
      .returning({ id: view.id })
  ).at(0)
  if (!row) throw new Error('insert returned nothing')
  return row.id
}

const read = (ids: ReadonlyArray<string>) =>
  Effect.runPromise(pinnedViewsProgram(me, ids))

describe('pinnedViewsProgram', () => {
  it('answers shared views and my private ones, with the object slug', async () => {
    const shared = await mkView({ name: 'Seed, India' })
    const mine = await mkView({ name: 'Mine', visibility: 'private' })
    const answer = await read([shared, mine])
    expect(answer.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        id: mine,
        name: 'Mine',
        objectSlug: 'companies',
        visibility: 'private',
      },
      {
        id: shared,
        name: 'Seed, India',
        objectSlug: 'companies',
        visibility: 'shared',
      },
    ])
  })

  it('leaves out a deleted view, a view private to someone else, a document view and one on an archived object', async () => {
    const other = `u-${randomUUID().slice(0, 8)}`
    await db
      .insert(user)
      .values({ id: other, name: 'Other', email: `${other}@example.test` })
    const kept = await mkView({ name: 'Kept' })
    const theirs = await mkView({
      name: 'Theirs',
      visibility: 'private',
      createdBy: other,
    })
    const gone = await mkView({ name: 'Gone' })
    await db.delete(view).where(eq(view.id, gone))
    const docs = await mkView({
      name: 'Docs',
      surface: 'document',
      objectId: null,
    })
    const archived = (
      await db
        .insert(objectDef)
        .values({
          slug: `funds_${randomUUID().slice(0, 6)}`,
          singular: 'Fund',
          plural: 'Funds',
          archived: true,
        })
        .returning({ id: objectDef.id })
    ).at(0)
    if (!archived) throw new Error('insert returned nothing')
    const onArchived = await mkView({
      name: 'Old funds',
      objectId: archived.id,
    })

    const answer = await read([kept, theirs, gone, docs, onArchived])
    expect(answer.map((v) => v.id)).toEqual([kept])
  })

  it('asks nothing for no pins', async () => {
    expect(await read([])).toEqual([])
  })
})
