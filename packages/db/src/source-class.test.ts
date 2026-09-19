import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from './index.ts'
import { entity, entityAlias } from './schema/entities.ts'
import { integration } from './schema/integrations.ts'

/**
 * The enum collapse, asserted where it happened — in Postgres (SPA-118).
 *
 * Two claims the TypeScript schema cannot make on its own. First that the
 * migration ran the conversion rather than dropping and re-adding columns:
 * the type exists with eight values and the two vendor-named types are
 * *gone* from `pg_type`, which is the part a `DROP COLUMN` would have left
 * standing. Second that the biconditional is real, and a biconditional has
 * two ways to break — an implication would let a `seed` row carry an
 * integration id, a provenance lie the dedupe card renders as fact.
 *
 * Both halves, both tables, asserted by *constraint name* for the reason
 * `actor-invariant.test.ts` gives: drizzle's `Failed query: …` message names
 * the SQL and not the constraint, so asserting on the message would pass for
 * a not-null violation or a typo in the fixture.
 */
function constraintOf(err: unknown): string | null {
  let cur: unknown = err
  for (let hop = 0; hop < 5; hop++) {
    if (!(cur instanceof Error)) return null
    const name: unknown = Reflect.get(cur, 'constraint')
    if (typeof name === 'string') return name
    cur = cur.cause
  }
  return null
}

async function refusedBy(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (err) {
    return constraintOf(err)
  }
}

const ENTITY_INVARIANT = 'entity_source_ref_invariant'
const ALIAS_INVARIANT = 'entity_alias_source_ref_invariant'

const EIGHT = [
  'manual',
  'integration',
  'ai',
  'import',
  'seed',
  'merge',
  'extracted',
  'inherited',
]

describe('source_class in Postgres', () => {
  const ids = { entity: '', integration: '' }

  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8)
    const i = await db
      .insert(integration)
      .values({ capabilityId: 'apollo', version: '1.0.0' })
      .returning({ id: integration.id })
    ids.integration = i[0].id
    const e = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `ClassCo ${tag}` })
      .returning({ id: entity.id })
    ids.entity = e[0].id
  })

  it('carries the eight values, in order', async () => {
    const res = await db.$client.query<{ v: string }>(
      'select unnest(enum_range(null::source_class))::text as v',
    )
    expect(res.rows.map((r) => r.v)).toEqual(EIGHT)
  })

  it('has no entity_source or alias_source type left', async () => {
    const res = await db.$client.query<{ typname: string }>(
      "select typname from pg_type where typname in ('entity_source', 'alias_source')",
    )
    expect(res.rows.map((r) => r.typname)).toEqual([])
  })

  it('defaults a row with no stated provenance to manual, unattributed', async () => {
    const rows = await db.select().from(entity)
    const row = rows.find((r) => r.id === ids.entity)
    expect(row?.sourceClass).toBe('manual')
    expect(row?.sourceRef).toBe(null)
  })

  it('accepts an integration-written entity that names its integration', async () => {
    const rows = await db
      .insert(entity)
      .values({
        kind: 'company',
        canonicalName: `PluginCo ${randomUUID().slice(0, 8)}`,
        sourceClass: 'integration',
        sourceRef: ids.integration,
      })
      .returning({ ref: entity.sourceRef })
    expect(rows[0].ref).toBe(ids.integration)
  })

  it('holds both halves on entity', async () => {
    // class = integration with no ref: the unattributed plugin write.
    expect(
      await refusedBy(
        db.insert(entity).values({
          kind: 'company',
          canonicalName: `Nameless ${randomUUID().slice(0, 8)}`,
          sourceClass: 'integration',
        }),
      ),
    ).toBe(ENTITY_INVARIANT)

    // and the other direction: a seed row wearing an integration's name.
    expect(
      await refusedBy(
        db.insert(entity).values({
          kind: 'company',
          canonicalName: `Liar ${randomUUID().slice(0, 8)}`,
          sourceClass: 'seed',
          sourceRef: ids.integration,
        }),
      ),
    ).toBe(ENTITY_INVARIANT)
  })

  it('holds both halves on entity_alias', async () => {
    const tag = randomUUID().slice(0, 8)
    expect(
      await refusedBy(
        db.insert(entityAlias).values({
          entityId: ids.entity,
          kind: 'domain',
          value: `nameless-${tag}.com`,
          valueNorm: `nameless-${tag}.com`,
          isIdentity: true,
          sourceClass: 'integration',
        }),
      ),
    ).toBe(ALIAS_INVARIANT)

    expect(
      await refusedBy(
        db.insert(entityAlias).values({
          entityId: ids.entity,
          kind: 'domain',
          value: `liar-${tag}.com`,
          valueNorm: `liar-${tag}.com`,
          isIdentity: true,
          sourceClass: 'merge',
          sourceRef: ids.integration,
        }),
      ),
    ).toBe(ALIAS_INVARIANT)

    const ok = await db
      .insert(entityAlias)
      .values({
        entityId: ids.entity,
        kind: 'domain',
        value: `attributed-${tag}.com`,
        valueNorm: `attributed-${tag}.com`,
        isIdentity: true,
        sourceClass: 'integration',
        sourceRef: ids.integration,
      })
      .returning({ ref: entityAlias.sourceRef })
    expect(ok[0].ref).toBe(ids.integration)
  })

  it('refuses a source_ref that names no integration', async () => {
    const refused = await refusedBy(
      db.insert(entity).values({
        kind: 'company',
        canonicalName: `Ghost ${randomUUID().slice(0, 8)}`,
        sourceClass: 'integration',
        sourceRef: randomUUID(),
      }),
    )
    expect(refused).toBe('entity_source_ref_integration_id_fk')
  })
})
