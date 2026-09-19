import { count, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entitySpace,
  link,
  note,
  person,
  space,
  term,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { EntityValues } from '@spaces/db/schema/entities'
import { resolveEntity } from '#/lib/entities/resolve'

/**
 * Demo data — opt-in at setup, never automatic.
 *
 * This is the answer to "never show an empty table" now that the starter
 * taxonomy is deliberately tiny: rather than shipping an opinionated
 * ontology as if it were doctrine, ship an obviously-fictional worked
 * example the operator chooses, and can delete.
 *
 * It exercises the seam the product is built around — a company that lands
 * in a pipeline already carrying the space it was researched in and the
 * notes written there.
 */

const SPACE_TREE = [
  { slug: 'data_centers', name: 'Data centers', parent: null },
  { slug: 'cooling', name: 'Cooling', parent: 'data_centers' },
  { slug: 'immersion', name: 'Immersion cooling', parent: 'cooling' },
]

const COMPANIES: Array<{
  name: string
  domain: string
  space: string
  values: EntityValues
}> = [
  {
    name: 'Submer',
    domain: 'submer.com',
    space: 'immersion',
    values: {
      description: 'Immersion cooling for high-density racks.',
      funding_stage: 'series_b',
      location: 'Barcelona',
    },
  },
  {
    name: 'LiquidStack',
    domain: 'liquidstack.com',
    space: 'immersion',
    values: {
      description: 'Two-phase immersion cooling, originally for mining rigs.',
      location: 'Texas',
    },
  },
  {
    name: 'Iceotope',
    domain: 'iceotope.com',
    space: 'cooling',
    values: {
      description: 'Precision liquid cooling, chassis-level.',
      location: 'Sheffield',
    },
  },
]

const TERMS = [
  {
    name: 'PUE',
    aliases: ['power usage effectiveness'],
    definition:
      'Power Usage Effectiveness — total facility power divided by IT equipment power. 1.0 is perfect; air-cooled halls sit near 1.5, liquid-cooled ones near 1.05.',
    space: 'data_centers',
  },
  {
    name: 'Rack density',
    aliases: ['kW per rack'],
    definition:
      'Power drawn by a single rack. Air cooling runs out somewhere past 30kW, which is the wedge every liquid-cooling company is selling into.',
    space: 'cooling',
  },
  {
    name: 'Two-phase',
    aliases: [],
    definition:
      'Immersion cooling where the fluid boils and condenses. Better heat transfer than single-phase, worse regulatory story since the fluids are often PFAS.',
    space: 'immersion',
  },
]

/** True when there is nothing but the starter taxonomy — safe to seed. */
export async function canSeedDemo(): Promise<boolean> {
  const [{ value }] = await db
    .select({ value: count() })
    .from(entity)
    .where(eq(entity.kind, 'company'))
  return value === 0
}

export async function seedDemoData(
  userId: string,
): Promise<{ seeded: boolean }> {
  if (!(await canSeedDemo())) return { seeded: false }

  // --- spaces -------------------------------------------------------------
  const spaceIds = new Map<string, string>()
  // Paths accumulate down the tree: the child of a child needs its parent's
  // *full* path, not its parent's slug, or a third-level node silently lands
  // at the root as `cooling.immersion` instead of
  // `data_centers.cooling.immersion`.
  const spacePaths = new Map<string, string>()
  for (const node of SPACE_TREE) {
    const parentPath = node.parent ? spacePaths.get(node.parent) : null
    const path = parentPath ? `${parentPath}.${node.slug}` : node.slug
    spacePaths.set(node.slug, path)
    const existing = await db
      .select({ entityId: space.entityId })
      .from(space)
      .where(eq(space.path, path))
      .limit(1)
    if (existing[0]) {
      spaceIds.set(node.slug, existing[0].entityId)
      continue
    }
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: node.name, source: 'seed' })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: ent.id,
      parentId: node.parent ? (spaceIds.get(node.parent) ?? null) : null,
      slug: node.slug,
      path,
      isSeeded: true,
    })
    spaceIds.set(node.slug, ent.id)
  }

  // --- companies, through the one choke point -----------------------------
  // resolveEntity, not a raw insert: demo data must go through the same
  // identity rules as everything else, or it is not a demo of this product.
  const companyIds = new Map<string, string>()
  for (const c of COMPANIES) {
    const result = await resolveEntity({
      kind: 'company',
      name: c.name,
      keys: { domain: c.domain },
      source: 'import',
      createdBy: userId,
    })
    companyIds.set(c.name, result.entityId)
    await db
      .update(entity)
      .set({ values: c.values })
      .where(eq(entity.id, result.entityId))
    await db
      .insert(company)
      .values({ entityId: result.entityId })
      .onConflictDoNothing()
    const spaceId = spaceIds.get(c.space)
    if (spaceId) {
      await db
        .insert(entitySpace)
        .values({
          entityId: result.entityId,
          spaceId,
          source: 'manual',
          createdBy: userId,
        })
        .onConflictDoNothing()
    }
    await db.insert(activity).values({
      actorId: userId,
      verb: 'company.created',
      subjectEntityId: result.entityId,
    })
  }

  // --- a person, contact_at a company -------------------------------------
  const personResult = await resolveEntity({
    kind: 'person',
    name: 'Ana Ruiz',
    keys: { email: 'ana@submer.com' },
    source: 'import',
    createdBy: userId,
  })
  await db
    .insert(person)
    .values({ entityId: personResult.entityId })
    .onConflictDoNothing()
  await db
    .update(entity)
    .set({ values: { job_title: 'Co-founder & CTO' } })
    .where(eq(entity.id, personResult.entityId))
  const submerId = companyIds.get('Submer')
  if (submerId) {
    await db
      .insert(link)
      .values({
        fromEntityId: personResult.entityId,
        toEntityId: submerId,
        relation: 'contact_at',
        source: 'manual',
        createdBy: userId,
      })
      .onConflictDoNothing()
  }

  // --- glossary -----------------------------------------------------------
  for (const t of TERMS) {
    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'term',
        canonicalName: t.name,
        source: 'seed',
        createdBy: userId,
      })
      .returning({ id: entity.id })
    await db.insert(term).values({
      entityId: ent.id,
      name: t.name,
      aliases: t.aliases,
      definitionMd: t.definition,
      spaceId: spaceIds.get(t.space) ?? null,
    })
  }

  // --- a memo filed in the space, using the glossary vocabulary -----------
  const [memoEnt] = await db
    .insert(entity)
    .values({
      kind: 'note',
      canonicalName: 'Why liquid cooling, and why now',
      source: 'import',
      createdBy: userId,
    })
    .returning({ id: entity.id })
  const memoBody =
    'Air cooling runs out of road somewhere past 30kW of rack density, and ' +
    'accelerator racks are already past it. That makes liquid cooling a ' +
    'when-not-if market.\n\n' +
    'The interesting question is which approach wins. Two-phase has the best ' +
    'heat transfer and the worst regulatory story. Single-phase immersion is ' +
    'duller and probably right. Direct-to-chip is the incumbents’ answer and ' +
    'ships today.\n\n' +
    'Watch PUE claims carefully — everyone quotes the number from their best ' +
    'installation.'
  await db.insert(note).values({
    entityId: memoEnt.id,
    title: 'Why liquid cooling, and why now',
    bodyMd: memoBody,
    bodyJson: memoBody.split('\n\n').map((para) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: para, styles: {} }],
    })),
    kind: 'memo',
    authorId: userId,
  })
  const coolingId = spaceIds.get('cooling')
  if (coolingId) {
    await db
      .insert(entitySpace)
      .values({
        entityId: memoEnt.id,
        spaceId: coolingId,
        source: 'manual',
        createdBy: userId,
      })
      .onConflictDoNothing()
  }

  console.log('[demo] seeded demo data')
  return { seeded: true }
}
