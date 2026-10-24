import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, entitySpace, space } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  getRegistryByObjectId,
  setValues,
} from '@spaces/core/writes/attributes/values'
import { objectIdForKindAsync } from '@spaces/core/writes/attributes/objects'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { kindLanesProgram } from './kind-lanes'

/**
 * A Records row's kind lane: the object's singular, the stage word
 * and the first live space the record was filed in, with its ancestors.
 */

async function newSpace(
  name: string,
  path: string,
  parentId: string | null = null,
  archivedAt: Date | null = null,
) {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(space).values({
    entityId: row.id,
    parentId,
    slug: path.split('.').at(-1) ?? path,
    path,
    archivedAt,
  })
  return row.id
}

async function fileIn(entityId: string, spaceId: string, createdAt: Date) {
  await db
    .insert(entitySpace)
    .values({ entityId, spaceId, createdBy: FIXTURE_ACTOR.id, createdAt })
}

describe('kindLanesProgram', () => {
  it('reads a company’s singular, its funding stage label and its first live space path', async () => {
    const co = (
      await resolveEntity({
        kind: 'company',
        name: 'Flent',
        keys: { domain: 'flent.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const registry = await getRegistryByObjectId(
      await objectIdForKindAsync('company'),
    )
    const seed = registry
      .find((d) => d.slug === 'funding_stage')
      ?.options.options?.find((o) => o.label === 'Seed')
    if (!seed) throw new Error('no Seed option')
    await setValues({
      entityId: co,
      patch: { funding_stage: seed.id },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })

    const proptech = await newSpace('Proptech', 'proptech')
    const ops = await newSpace(
      'Property ops',
      'proptech.property_ops',
      proptech,
    )
    const gone = await newSpace('Old thesis', 'old_thesis', null, new Date())
    const later = await newSpace('Rentals', 'rentals')
    // The archived space was filed first; the live one after it leads.
    await fileIn(co, gone, new Date('2026-01-01T00:00:00Z'))
    await fileIn(co, ops, new Date('2026-02-01T00:00:00Z'))
    await fileIn(co, later, new Date('2026-03-01T00:00:00Z'))

    const lanes = await Effect.runPromise(kindLanesProgram([co]))
    expect(lanes.get(co)).toEqual({
      singular: 'Company',
      stage: 'Seed',
      space: 'Proptech › Property ops',
    })
  })

  it('answers no stage and no space for a record with neither, and nothing for no ids', async () => {
    const co = (
      await resolveEntity({
        kind: 'company',
        name: 'Bare Co',
        keys: { domain: 'bare.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const lanes = await Effect.runPromise(kindLanesProgram([co]))
    expect(lanes.get(co)).toEqual({
      singular: 'Company',
      stage: null,
      space: null,
    })
    expect((await Effect.runPromise(kindLanesProgram([]))).size).toBe(0)
  })
})
