import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from './index.ts'
import { user } from './schema/auth.ts'
import { entity } from './schema/entities.ts'
import { integration } from './schema/integrations.ts'
import { attributeEvent } from './schema/attributes.ts'

/**
 * The typed actor's invariant, asserted where it lives — in Postgres (SPA-70).
 *
 * `attribute_event`'s check is a pair of biconditionals, and a biconditional
 * has two ways to break. An implication would let a `system` row carry an
 * integration id, which is a provenance lie the timeline would render as
 * fact; so each half is tested in both directions, by expecting the insert
 * to throw. A test that only asserted the happy path would pass against no
 * constraint at all.
 */
/**
 * Which constraint Postgres refused on. drizzle wraps the driver error in a
 * `Failed query: …` message that names the SQL and not the constraint, so
 * asserting on the message would pass for any rejection at all — including a
 * not-null violation or a typo in the fixture. The name lives on `constraint`
 * somewhere down the `cause` chain; this walks to it, and returns null when
 * the call did not throw, so a missing constraint reads as `null` rather than
 * as a quietly passing test.
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

const INVARIANT = 'attribute_event_actor_invariant'

describe('attribute_event actor invariant', () => {
  const ids = { entity: '', integration: '', user: '' }

  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8)
    const e = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `ActorCo ${tag}` })
      .returning({ id: entity.id })
    ids.entity = e[0].id

    const u = await db
      .insert(user)
      .values({
        id: `actor-invariant-${tag}`,
        name: `Actor ${tag}`,
        email: `actor-${tag}@spaces.test`,
      })
      .returning({ id: user.id })
    ids.user = u[0].id

    const i = await db
      .insert(integration)
      .values({ capabilityId: 'apollo', version: '1.0.0' })
      .returning({ id: integration.id })
    ids.integration = i[0].id
  })

  /** The column defaults the acceptance criterion names, read back from PG. */
  it('gives an integration row installing / 0 / false by default', async () => {
    const rows = await db.select().from(integration)
    const row = rows.find((r) => r.id === ids.integration)
    expect(row?.status).toBe('installing')
    expect(row?.errorCount).toBe(0)
    expect(row?.enabled).toBe(false)
    expect(row?.config).toEqual({})
    expect(row?.capabilityId).toBe('apollo')
  })

  it('accepts an integration event that names its integration', async () => {
    const rows = await db
      .insert(attributeEvent)
      .values({
        entityId: ids.entity,
        attrSlug: 'sector',
        to: 'Fintech',
        actorType: 'integration',
        actorRef: ids.integration,
        source: 'enrichment',
      })
      .returning({ id: attributeEvent.id, actorRef: attributeEvent.actorRef })
    expect(rows[0].actorRef).toBe(ids.integration)
  })

  it('rejects an integration event with no actor_ref', async () => {
    const refused = await refusedBy(
      db.insert(attributeEvent).values({
        entityId: ids.entity,
        attrSlug: 'sector',
        to: 'Fintech',
        actorType: 'integration',
        source: 'enrichment',
      }),
    )
    expect(refused).toBe(INVARIANT)
  })

  it('rejects a non-integration event carrying an actor_ref', async () => {
    // system: no actor_id to satisfy, so this isolates the second half.
    expect(
      await refusedBy(
        db.insert(attributeEvent).values({
          entityId: ids.entity,
          attrSlug: 'sector',
          to: 'Fintech',
          actorType: 'system',
          actorRef: ids.integration,
          source: 'merge',
        }),
      ),
    ).toBe(INVARIANT)

    // and a user event, which must satisfy both halves at once.
    expect(
      await refusedBy(
        db.insert(attributeEvent).values({
          entityId: ids.entity,
          attrSlug: 'sector',
          to: 'Fintech',
          actorType: 'user',
          actorId: ids.user,
          actorRef: ids.integration,
          source: 'direct',
        }),
      ),
    ).toBe(INVARIANT)
  })

  it('still holds the user half in both directions', async () => {
    expect(
      await refusedBy(
        db.insert(attributeEvent).values({
          entityId: ids.entity,
          attrSlug: 'sector',
          to: 'Fintech',
          actorType: 'user',
          source: 'direct',
        }),
      ),
    ).toBe(INVARIANT)

    expect(
      await refusedBy(
        db.insert(attributeEvent).values({
          entityId: ids.entity,
          attrSlug: 'sector',
          to: 'Fintech',
          actorType: 'system',
          actorId: ids.user,
          source: 'merge',
        }),
      ),
    ).toBe(INVARIANT)

    const ok = await db
      .insert(attributeEvent)
      .values({
        entityId: ids.entity,
        attrSlug: 'sector',
        to: 'Fintech',
        actorType: 'user',
        actorId: ids.user,
        source: 'direct',
      })
      .returning({ id: attributeEvent.id })
    expect(ok[0].id).toBeTruthy()
  })
})
