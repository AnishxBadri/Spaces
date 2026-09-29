import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, objectDef, user } from '@spaces/db/schema'
import { createObjectProgram } from '@spaces/core/writes/attributes/object-registry'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import type { CreateObjectInput } from '@spaces/core/writes/attributes/object-registry'
import type { EntityValues } from '@spaces/db/schema'
import type { AttributeType } from '@spaces/core/attributes/registry'

/**
 * The volume bench — one custom object and twenty thousand records of it.
 *
 * `dev.ts` is the developer's *working* fund: a few dozen rows, every
 * surface with something true on it. This is the other question, and it is
 * the one SPA-64 exists to answer: does `/o/$slug` still paint when the CSV
 * import area has filled a table? Nothing here is meant to be read. The
 * values are varied on purpose — six attributes across the four shapes the
 * compiler casts differently (select, number, currency, date, text) so a
 * filter and a sort each have something to be slow about.
 *
 * It writes rows into `entity` directly rather than through
 * `createRecordProgram`: twenty thousand validated writes with their
 * activity rows and their link rows would take an hour and would measure the
 * write path, which is not the thing being measured. `apps/web/src/lib/seeds/**`
 * is the sanctioned exemption from the `entity.values` write-path rule.
 *
 * **Never point this at the dev `spaces` database.** `seedBigObject` writes
 * whatever `DATABASE_URL` names; the runner (`src/db/seed-big.ts`) refuses a
 * database whose name does not look like a test one unless told twice.
 */

const STAGES = ['Seed', 'Series A', 'Growth', 'Late', 'Secondary']
const REGIONS = ['North America', 'Europe', 'India', 'SEA', 'LatAm']
const MANAGERS = [
  'Alder',
  'Birchwood',
  'Cedarline',
  'Dunmore',
  'Elmgate',
  'Fernhill',
  'Greystone',
  'Holloway',
]

const DEFS: Array<{
  name: string
  type: AttributeType
  options?: Array<{ label: string }>
}> = [
  {
    name: 'Stage',
    type: 'select',
    options: STAGES.map((label) => ({ label })),
  },
  {
    name: 'Region',
    type: 'select',
    options: REGIONS.map((label) => ({ label })),
  },
  { name: 'Vintage', type: 'number' },
  { name: 'Committed', type: 'currency' },
  { name: 'First close', type: 'date' },
  { name: 'Manager', type: 'text' },
]

/**
 * A deterministic 32-bit mixer. `Math.random()` would make two runs
 * incomparable, and an EXPLAIN is only a baseline if the next one can be run
 * against the same rows.
 */
function mix(n: number): number {
  let x = (n + 0x9e3779b9) | 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
  return (x ^ (x >>> 15)) >>> 0
}

export type BigSeedResult = {
  objectId: string
  objectSlug: string
  created: number
  /** Slugs in declaration order, so a caller can name one to sort by. */
  slugs: Array<string>
}

/**
 * Creates (or reuses) the object, gives it the six attributes it lacks, and
 * inserts `count` records. Idempotent on the object and the attributes;
 * additive on the records, so a second run doubles them.
 */
export async function seedBigObject({
  count = 20_000,
  plural = 'Funds',
  singular = 'Fund',
  batch = 1000,
}: {
  count?: number
  plural?: string
  singular?: string
  batch?: number
} = {}): Promise<BigSeedResult> {
  const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!actor)
    throw new Error('[seed:big] no users yet — migrate and seed first')

  const existing = (
    await db
      .select({ id: objectDef.id, slug: objectDef.slug })
      .from(objectDef)
      .where(eq(objectDef.plural, plural))
  ).at(0)
  const input: CreateObjectInput = {
    singular,
    plural,
    createdBy: actor.id,
  }
  const object =
    existing ?? (await Effect.runPromise(createObjectProgram(input)))

  const live = await db
    .select({ slug: attribute.slug, name: attribute.name })
    .from(attribute)
    .where(
      and(eq(attribute.objectId, object.id), eq(attribute.archived, false)),
    )
  const have = new Set(live.map((a) => a.name))
  for (const def of DEFS) {
    if (have.has(def.name)) continue
    await Effect.runPromise(
      createAttributeProgram({
        objectId: object.id,
        name: def.name,
        type: def.type,
        ...(def.options ? { options: def.options } : {}),
        createdBy: actor.id,
      }),
    )
  }

  const defs = await db
    .select({
      slug: attribute.slug,
      name: attribute.name,
      options: attribute.options,
    })
    .from(attribute)
    .where(eq(attribute.objectId, object.id))
  const slugOf = (name: string) =>
    defs.find((d) => d.name === name)?.slug ?? name.toLowerCase()
  const optionIds = (name: string) =>
    defs.find((d) => d.name === name)?.options.options?.map((o) => o.id) ?? []

  const stage = { slug: slugOf('Stage'), ids: optionIds('Stage') }
  const region = { slug: slugOf('Region'), ids: optionIds('Region') }
  const vintage = slugOf('Vintage')
  const committed = slugOf('Committed')
  const firstClose = slugOf('First close')
  const manager = slugOf('Manager')

  const base = (
    await db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.objectId, object.id), eq(entity.kind, 'custom')))
  ).length

  for (let start = 0; start < count; start += batch) {
    const rows = Array.from(
      { length: Math.min(batch, count - start) },
      (_, k) => {
        const i = base + start + k
        const r = mix(i)
        // One record in eleven leaves Vintage unset and one in seven leaves
        // Manager unset — the null tail a NULLS LAST sort has to page over.
        const values: EntityValues = {
          [stage.slug]: stage.ids[r % Math.max(1, stage.ids.length)] ?? null,
          [region.slug]:
            region.ids[(r >>> 4) % Math.max(1, region.ids.length)] ?? null,
          [committed]: String(2_500_000 + ((r >>> 7) % 400) * 250_000),
          [firstClose]: `20${String(10 + ((r >>> 11) % 16)).padStart(2, '0')}-${String(
            1 + ((r >>> 17) % 12),
          ).padStart(
            2,
            '0',
          )}-${String(1 + ((r >>> 21) % 28)).padStart(2, '0')}`,
        }
        if (i % 11 !== 0) values[vintage] = 2010 + ((r >>> 3) % 16)
        if (i % 7 !== 0)
          values[manager] = `${MANAGERS[(r >>> 9) % MANAGERS.length]} Capital`
        return {
          kind: 'custom' as const,
          objectId: object.id,
          canonicalName: `${MANAGERS[r % MANAGERS.length]} ${singular} ${String(i).padStart(6, '0')}`,
          values,
          createdBy: actor.id,
        }
      },
    )
    await db.insert(entity).values(rows)
  }

  return {
    objectId: object.id,
    objectSlug: object.slug,
    created: count,
    slugs: [stage.slug, region.slug, vintage, committed, firstClose, manager],
  }
}
