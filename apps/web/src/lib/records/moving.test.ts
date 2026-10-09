import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { db } from '@spaces/db'
import { activity, entity, entitySpace, signal, space } from '@spaces/db/schema'
import { movingProgram } from './moving'

/**
 * What's moving lists the last seven days' signals on companies the reader
 * touched — created, logged an interaction on, or filed — newest first.
 * Against this worker's test database, truncated before the file.
 */

const DAY = 86_400_000
const now = new Date('2026-10-10T12:00:00Z')
const ago = (days: number) => new Date(now.getTime() - days * DAY)

async function mint(
  kind: 'company' | 'person' | 'space',
  name: string,
  createdBy: string | null,
) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name, createdBy })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no entity')
  return row.id
}

describe('movingProgram', () => {
  it('keeps the touched companies’ recent signals, newest first', async () => {
    const me = (
      await db.execute<{ id: string }>('select id from "user" limit 1')
    ).rows[0].id

    const created = await mint('company', 'Created Co', me)
    const filed = await mint('company', 'Filed Co', null)
    const logged = await mint('company', 'Logged Co', null)
    const untouched = await mint('company', 'Untouched Co', null)
    const person = await mint('person', 'Ada', me)
    const shelf = await mint('space', 'Shelf', null)

    await db
      .insert(space)
      .values({ entityId: shelf, slug: 'tday_shelf', path: 'tday_shelf' })
    await db
      .insert(entitySpace)
      .values({ entityId: filed, spaceId: shelf, createdBy: me })
    await db.insert(activity).values({
      actorId: me,
      verb: 'interaction.call',
      subjectEntityId: logged,
    })

    const emit = (entityId: string, title: string, at: Date) =>
      db.insert(signal).values({
        entityId,
        source: 'exa',
        payload: { kind: 'funding', title, url: 'https://news.example/x' },
        observedAt: at,
      })
    await emit(created, 'Created raised', ago(2))
    await emit(created, 'Created, long ago', ago(10))
    await emit(filed, 'Filed raised', ago(1))
    await emit(logged, 'Logged raised', ago(0))
    await emit(untouched, 'Untouched raised', ago(0))
    await emit(person, 'Ada moved', ago(0))

    const moving = await Effect.runPromise(movingProgram(me, now))
    expect(moving.map((m) => [m.companyName, m.title])).toEqual([
      ['Logged Co', 'Logged raised'],
      ['Filed Co', 'Filed raised'],
      ['Created Co', 'Created raised'],
    ])
    expect(moving[0]).toMatchObject({
      kind: 'funding',
      url: 'https://news.example/x',
      source: 'exa',
    })
  })
})
