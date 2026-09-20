import { describe, expect, it } from 'vitest'

/**
 * SPA-76. What the pair card reads off each side, and the two hardcodings it
 * replaced: the heading's noun and the link.
 *
 * `entityContext` left-joins the object registry rather than switching on
 * `entity.kind`, so a custom pair reads "Same Fund?" and links into
 * `/o/funds/<id>` through the same `recordPath` every other list uses. Core
 * rows carry an object row too (`CORE_OBJECTS`), which is why one join
 * answers for both and no ternary survives in the component.
 *
 * Integration against this worker's test database, truncated and reseeded
 * before the file was imported (SPA-145) — no cleanup here.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db.select({ id: user.id }).from(user).limit(1)
  expect(row).toBeTruthy()
  return row.id
}

describe('entityContext — the noun and the link', () => {
  it('reads a core company as its registry row, not as its kind', async () => {
    const { resolveEntity } = await import('#/lib/entities/resolve')
    const { entityContext } = await import('#/lib/inbox/context')
    const { recordPath } = await import('#/lib/record-path')

    const co = await resolveEntity({
      kind: 'company',
      name: 'Northwind Systems',
      source: { class: 'manual' },
    })
    const side = await entityContext(co.entityId)

    expect(side.objectSingular).toBe('Company')
    expect(side.objectSlug).toBe('companies')
    expect(recordPath(side)).toBe(`/companies/${co.entityId}`)
  })

  it("gives a custom record its object's own singular and route", async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, createRecordProgram } =
      await import('#/lib/attributes/object-registry')
    const { entityContext } = await import('#/lib/inbox/context')
    const { recordPath } = await import('#/lib/record-path')

    const actor = await actorId()
    const object = await Effect.runPromise(
      createObjectProgram({
        singular: 'Fund',
        plural: 'Funds',
        createdBy: actor,
      }),
    )
    const record = await Effect.runPromise(
      createRecordProgram({
        objectId: object.id,
        name: 'Sequoia Growth III',
        actor: { type: 'user', id: actor },
      }),
    )
    const side = await entityContext(record.id)

    // The heading is `Same {objectSingular}?` — verbatim, so an object named
    // "LP" never renders "Same lp?".
    expect(side.objectSingular).toBe('Fund')
    expect(side.objectSlug).toBe('funds')
    expect(recordPath(side)).toBe(`/o/funds/${record.id}`)
  })

  it('answers null for a kind with no object row, and no page', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { entityContext } = await import('#/lib/inbox/context')
    const { recordPath } = await import('#/lib/record-path')

    // A research kind: no object row to join, so no noun and no route. The
    // row goes in directly — `resolveEntity` only births the object kinds.
    const [term] = await db
      .insert(entity)
      .values({ kind: 'term', canonicalName: 'Liquidation preference' })
      .returning({ id: entity.id })
    const side = await entityContext(term.id)

    expect(side.objectSingular).toBeNull()
    expect(side.objectSlug).toBeNull()
    // `sideName` renders plain text here rather than a broken link.
    expect(recordPath(side)).toBeNull()
  })
})

/**
 * SPA-97. The Domain row's fallback. The side that *caused* an identity pair
 * is the side that lost the claim, so it holds no domain alias — the card
 * printed "—" for the record under discussion. `identityDomain` is that
 * side's own value for its object's `domain` identity key.
 */
describe('entityContext — the colliding side still shows its domain', () => {
  it('reads the record’s identity-key value when no alias was won', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, createRecordProgram } =
      await import('#/lib/attributes/object-registry')
    const { entityContext } = await import('#/lib/inbox/context')

    const actor = await actorId()
    const object = await Effect.runPromise(
      createObjectProgram({
        singular: 'Vendor',
        plural: 'Vendors',
        identityKeys: ['domain'],
        createdBy: actor,
      }),
    )
    const holder = await Effect.runPromise(
      createRecordProgram({
        objectId: object.id,
        name: 'Northwind Supply',
        values: { domain: 'northwind.example' },
        actor: { type: 'user', id: actor },
      }),
    )
    // The second record types the same domain: the value lands, the claim
    // does not, and the pair is born.
    const loser = await Effect.runPromise(
      createRecordProgram({
        objectId: object.id,
        name: 'Northwind Supply Co',
        values: { domain: 'https://Northwind.example/' },
        actor: { type: 'user', id: actor },
      }),
    )
    expect(loser.identity).toEqual({ domain: 'suggested_duplicate' })
    expect(loser.identityValues).toEqual({ domain: 'northwind.example' })

    const winnerSide = await entityContext(holder.id)
    const loserSide = await entityContext(loser.id)

    // The winner owns the alias; the loser owns none and would have read
    // "—" before the fallback.
    expect(winnerSide.domains).toEqual(['northwind.example'])
    expect(loserSide.domains).toEqual([])
    // Normalized the same way the alias lane is, so the two columns compare.
    expect(loserSide.identityDomain).toBe('northwind.example')
  })

  it('leaves a core company pair reading its aliases, not a fallback', async () => {
    const { resolveEntity } = await import('#/lib/entities/resolve')
    const { entityContext } = await import('#/lib/inbox/context')

    const co = await resolveEntity({
      kind: 'company',
      name: 'Contoso Analytics',
      keys: { domain: 'contoso.example' },
      source: { class: 'manual' },
    })
    const side = await entityContext(co.entityId)

    expect(side.domains).toEqual(['contoso.example'])
    // The system company object declares no identity-key attribute, so the
    // fallback is null by construction and the alias lane is what renders.
    expect(side.identityDomain).toBeNull()
  })
})
