import { Effect, Schema } from 'effect'
import { count, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entitySpace,
  note,
  person,
  space,
  term,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { EntityValues } from '@spaces/db/schema/entities'
import { workspace } from '@spaces/db/schema/workspace'
import type { WorkspaceSettings } from '@spaces/db/schema/workspace'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { setValues } from '@spaces/core/writes/attributes/values'
import { deleteEntityProgram } from '@spaces/core/writes/entities/delete'

/**
 * Demo data — opt-in at setup, never automatic.
 *
 * The answer to "never show an empty table" with a deliberately tiny
 * starter taxonomy: an obviously fictional worked example the operator
 * chooses, and can delete, rather than an opinionated ontology.
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
  // Every entity this run births, and only those: a space the starter
  // taxonomy already held is reused and never recorded.
  const born: Array<string> = []

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
      .values({
        kind: 'space',
        canonicalName: node.name,
        sourceClass: 'seed',
      })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: ent.id,
      parentId: node.parent ? (spaceIds.get(node.parent) ?? null) : null,
      slug: node.slug,
      path,
      isSeeded: true,
    })
    born.push(ent.id)
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
      source: { class: 'import' },
      createdBy: userId,
    })
    companyIds.set(c.name, result.entityId)
    if (result.action === 'created') born.push(result.entityId)
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

  // --- a person at a company ---------------------------------------------
  const personResult = await resolveEntity({
    kind: 'person',
    name: 'Ana Ruiz',
    keys: { email: 'ana@submer.com' },
    source: { class: 'import' },
    createdBy: userId,
  })
  if (personResult.action === 'created') born.push(personResult.entityId)
  await db
    .insert(person)
    .values({ entityId: personResult.entityId })
    .onConflictDoNothing()
  await db
    .update(entity)
    // Merged, so the name parts and emails the birth wrote stay.
    .set({
      values: sql`${entity.values} || ${JSON.stringify({ job_title: 'Co-founder & CTO' })}::jsonb`,
    })
    .where(eq(entity.id, personResult.entityId))
  const submerId = companyIds.get('Submer')
  if (submerId) {
    await setValues({
      entityId: personResult.entityId,
      patch: { companies: [submerId] },
      actor: { type: 'user', id: userId },
      source: 'seed',
    })
  }

  // --- glossary -----------------------------------------------------------
  for (const t of TERMS) {
    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'term',
        canonicalName: t.name,
        sourceClass: 'seed',
        createdBy: userId,
      })
      .returning({ id: entity.id })
    born.push(ent.id)
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
      sourceClass: 'import',
      createdBy: userId,
    })
    .returning({ id: entity.id })
  born.push(memoEnt.id)
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

  await recordDemo(born)
  console.log('[demo] seeded demo data')
  return { seeded: true }
}

// --- removal -------------------------------------------------------------

/** `workspace.settings.demo`: the ids `seedDemoData` birthed. Absent once removed. */
const demoSetting = z.object({ entity_ids: z.array(z.string()) })

/** The recorded demo ids, or null when no demo data is recorded. */
export function demoIdsOf(settings: WorkspaceSettings): Array<string> | null {
  const parsed = demoSetting.safeParse(settings.demo)
  return parsed.success ? parsed.data.entity_ids : null
}

async function recordDemo(ids: Array<string>) {
  const demo = { entity_ids: ids }
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Workspace', settings: { demo } })
    .onConflictDoUpdate({
      target: workspace.id,
      set: {
        settings: sql`${workspace.settings} || jsonb_build_object('demo', ${JSON.stringify(demo)}::jsonb)`,
        updatedAt: new Date(),
      },
    })
}

export class DemoQueryFailed extends Schema.TaggedError<DemoQueryFailed>()(
  'DemoQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DemoQueryFailed({ cause }),
  })

type EntityKind = (typeof entity.kind.enumValues)[number]

/** What is left of the demo, by kind; null when none is recorded. */
export type DemoSummary = {
  readonly total: number
  readonly byKind: Partial<Record<EntityKind, number>>
}

/** The recorded demo records that still exist. */
const demoRows = Effect.fn('demoRows')(function* () {
  const row = (yield* query(() =>
    db
      .select({ settings: workspace.settings })
      .from(workspace)
      .where(eq(workspace.id, 1)),
  )).at(0)
  const ids = row === undefined ? null : demoIdsOf(row.settings)
  if (ids === null) return null
  if (ids.length === 0) return []
  return yield* query(() =>
    db
      .select({ id: entity.id, kind: entity.kind, path: space.path })
      .from(entity)
      .leftJoin(space, eq(space.entityId, entity.id))
      .where(inArray(entity.id, ids)),
  )
})

/** The counts the Remove confirm names; null when there is no demo key. */
export const demoSummaryProgram = Effect.fn('demoSummaryProgram')(
  function* (): Effect.fn.Return<DemoSummary | null, DemoQueryFailed> {
    const rows = yield* demoRows()
    if (rows === null) return null
    const byKind: Partial<Record<EntityKind, number>> = {}
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    return { total: rows.length, byKind }
  },
)

/**
 * The order a demo comes apart in: what points at a space before the space,
 * and a child space before its parent.
 */
const KIND_ORDER: ReadonlyArray<EntityKind> = [
  'note',
  'document',
  'term',
  'deal',
  'custom',
  'person',
  'company',
  'space',
]

/**
 * Remove demo data: delete exactly the recorded ids through the entity
 * delete program, then clear the key.
 * - A record the registry refuses to delete (a holding on a demo company)
 *   is kept and counted; so is a demo space that still has a space below it.
 * - Nothing created after the seed is touched — only recorded ids are read.
 */
export const removeDemoDataProgram = Effect.fn('removeDemoDataProgram')(
  function* (): Effect.fn.Return<
    { readonly removed: number; readonly kept: number },
    DemoQueryFailed
  > {
    const rows = yield* demoRows()
    if (rows === null) return { removed: 0, kept: 0 }
    const ordered = [...rows].sort((a, b) => {
      const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      if (k !== 0) return k
      // Deeper paths first, so a parent never outlives into a dangling child.
      return (b.path?.split('.').length ?? 0) - (a.path?.split('.').length ?? 0)
    })
    let removed = 0
    let kept = 0
    for (const r of ordered) {
      if (r.kind === 'space' && r.path !== null) {
        const path = r.path
        // Children went first, so any descendant left is one to keep it for.
        const below = yield* query(() =>
          db
            .select({ id: space.entityId })
            .from(space)
            .where(
              sql`${space.path} <@ ${path}::ltree and ${space.path} <> ${path}::ltree`,
            )
            .limit(1),
        )
        if (below.length > 0) {
          kept += 1
          continue
        }
      }
      const outcome = yield* deleteEntityProgram(r.id).pipe(
        Effect.map(() => 'removed' as const),
        Effect.catchTag('Blocked', () => Effect.succeed('kept' as const)),
        Effect.mapError((cause) => new DemoQueryFailed({ cause })),
      )
      if (outcome === 'removed') removed += 1
      else kept += 1
    }
    yield* query(() =>
      db
        .update(workspace)
        .set({
          settings: sql`${workspace.settings} - 'demo'`,
          updatedAt: new Date(),
        })
        .where(eq(workspace.id, 1)),
    )
    return { removed, kept }
  },
)
