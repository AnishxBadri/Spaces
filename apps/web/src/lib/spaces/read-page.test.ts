import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  attribute,
  company,
  entity,
  entitySpace,
  objectDef,
} from '@spaces/db/schema'
import { createSpaceRow } from '#/lib/server/shared'
import { stageMix } from './page'
import { getSpaceProgram } from './read'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * What the space page's head reads: the funding-stage options in the
 * registry's order, the last filing, and each company's filing time.
 */

const me = FIXTURE_ACTOR.id

async function aCompany(name: string, stage: string | null): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({
        kind: 'company',
        canonicalName: name,
        values: stage === null ? {} : { funding_stage: stage },
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(company).values({ entityId: row.id })
  return row.id
}

const file = (entityId: string, spaceId: string, at: Date) =>
  db
    .insert(entitySpace)
    .values({ entityId, spaceId, source: 'manual', createdAt: at })

async function registryOptions(): Promise<Array<string>> {
  const row = (
    await db
      .select({ options: attribute.options })
      .from(attribute)
      .innerJoin(objectDef, eq(objectDef.id, attribute.objectId))
      .where(
        and(
          eq(objectDef.slug, 'companies'),
          eq(attribute.slug, 'funding_stage'),
        ),
      )
  ).at(0)
  return (row?.options.options ?? []).map((o) => o.id)
}

describe('the space page read', () => {
  it('hands the page the funding-stage options in the registry order', async () => {
    const spaceId = await createSpaceRow('Property ops', null, me)
    const spc = await Effect.runPromise(getSpaceProgram(spaceId, me))
    expect(spc.stageOptions.map((o) => o.id)).toEqual(await registryOptions())
    expect(spc.stageOptions.length).toBeGreaterThan(0)
  })

  it('draws a bar that sums to the companies, bootstrapped last', async () => {
    const spaceId = await createSpaceRow('Proptech', null, me)
    const now = Date.now()
    const ids = await Promise.all([
      aCompany('Tenantry', 'seed'),
      aCompany('Arbor', 'series_a'),
      aCompany('Corbel', 'bootstrapped'),
      aCompany('Atrium', 'pre_seed'),
      aCompany('Bricks', null),
    ])
    for (const [i, id] of ids.entries()) {
      await file(id, spaceId, new Date(now - (i + 1) * 86_400_000))
    }

    const spc = await Effect.runPromise(getSpaceProgram(spaceId, me))
    const mix = stageMix(
      spc.companies.map((c) => c.stage),
      spc.stageOptions,
    )
    expect(mix.reduce((n, s) => n + s.count, 0)).toBe(spc.companies.length)
    expect(mix.map((s) => s.id)).toEqual([
      'pre_seed',
      'seed',
      'series_a',
      'bootstrapped',
      null,
    ])

    // The newest filing, a day old.
    expect(spc.lastFiled?.days).toBe(1)
    expect(spc.lastFiled?.on.slice(0, 10)).toBe(
      new Date(now - 86_400_000).toISOString().slice(0, 10),
    )
    const tenantry = spc.companies.find((c) => c.name === 'Tenantry')
    expect(tenantry?.filedAt.slice(0, 10)).toBe(
      new Date(now - 86_400_000).toISOString().slice(0, 10),
    )
    expect(spc.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('reads no last filing for an empty space', async () => {
    const spaceId = await createSpaceRow('Empty', null, me)
    const spc = await Effect.runPromise(getSpaceProgram(spaceId, me))
    expect(spc.lastFiled).toBeNull()
  })
})
