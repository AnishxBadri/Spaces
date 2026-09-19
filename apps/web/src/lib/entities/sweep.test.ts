import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * Integration tests against this worker's test database, truncated and
 * reseeded before the file was imported (SPA-145) — no cleanup here, and
 * nothing to add when a table appears.
 *
 * The fixture names carry no run tag on purpose: the two threshold cases are
 * pinned to a measured pg_trgm score, and a hex tag would move it. Isolation
 * comes from the object each record belongs to instead, which is the thing
 * this slice made the sweep respect.
 */

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x])

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db.select({ id: user.id }).from(user).limit(1)
  expect(row).toBeTruthy()
  return row.id
}

/** The measured score, straight from the extension the sweep queries. */
async function similarity(a: string, b: string): Promise<number> {
  const { db } = await import('@spaces/db')
  const { sql } = await import('drizzle-orm')
  const rows = await db.execute<{ s: number }>(
    sql`select similarity(${a}, ${b}) as s`,
  )
  return Number(rows.rows[0].s)
}

async function candidatesFor(id: string) {
  const { db } = await import('@spaces/db')
  const { duplicateCandidate } = await import('@spaces/db/schema')
  const { eq, or } = await import('drizzle-orm')
  return db
    .select()
    .from(duplicateCandidate)
    .where(
      or(
        eq(duplicateCandidate.entityA, id),
        eq(duplicateCandidate.entityB, id),
      ),
    )
}

async function newObject(singular: string, plural: string, createdBy: string) {
  const { Effect } = await import('effect')
  const { createObjectProgram } =
    await import('#/lib/attributes/object-registry')
  return Effect.runPromise(createObjectProgram({ singular, plural, createdBy }))
}

async function newRecord(objectId: string, name: string, userId: string) {
  const { Effect } = await import('effect')
  const { createRecordProgram } =
    await import('#/lib/attributes/object-registry')
  return Effect.runPromise(
    createRecordProgram({
      objectId,
      name,
      actor: { type: 'user', id: userId },
    }),
  )
}

describe('createRecordProgram birth alias', () => {
  it('writes a non-identity name alias, stamped as a manual birth', async () => {
    const { db } = await import('@spaces/db')
    const { entityAlias } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { normalizeName } = await import('@spaces/core/entities/normalize')

    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const obj = await newObject(`Vehicle ${tag}`, `Vehicles ${tag}`, me)
    const rec = await newRecord(obj.id, `Growth Vehicle ${tag}`, me)

    const aliases = await db
      .select()
      .from(entityAlias)
      .where(eq(entityAlias.entityId, rec.id))
    expect(aliases.length).toBe(1)
    const [alias] = aliases
    expect(alias.kind).toBe('name')
    expect(alias.value).toBe(`Growth Vehicle ${tag}`)
    expect(alias.valueNorm).toBe(normalizeName(`Growth Vehicle ${tag}`))
    // Non-identity: a custom object's identity keys are opt-in and unbuilt,
    // so this alias must never weld two records together.
    expect(alias.isIdentity).toBe(false)
    // Stamped exactly as resolveEntity stamps a manual birth alias.
    expect(alias.sourceClass).toBe('manual')
    expect(alias.sourceRef).toBe(null)
  })

  it('is one transaction with the entity row: the alias fails, the record is not born', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq, sql } = await import('drizzle-orm')

    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const obj = await newObject(`Tripwire ${tag}`, `Tripwires ${tag}`, me)
    const name = `Tripwire Record ${tag}`

    // A trigger that refuses exactly this record's alias. If the alias were
    // written after the entity insert committed, the entity row would
    // survive the refusal — which is the bug this criterion is about.
    await db.execute(
      sql.raw(`create function spa60_refuse_alias() returns trigger as $$
        begin
          if new.kind = 'name' then raise exception 'spa60 tripwire'; end if;
          return new;
        end $$ language plpgsql`),
    )
    await db.execute(
      sql.raw(`create trigger spa60_tripwire before insert on entity_alias
        for each row execute function spa60_refuse_alias()`),
    )
    try {
      // The tagged error carries an empty `message` and the pg error in
      // `cause`, so inspect the whole failure rather than its message.
      const failure = await newRecord(obj.id, name, me).then(
        () => null,
        (err: unknown) => inspect(err, { depth: 8 }),
      )
      expect(failure).toMatch(/spa60 tripwire/)
      const orphans = await db
        .select({ id: entity.id })
        .from(entity)
        .where(eq(entity.canonicalName, name))
      expect(orphans.length).toBe(0)
    } finally {
      await db.execute(
        sql.raw(`drop trigger if exists spa60_tripwire on entity_alias`),
      )
      await db.execute(sql.raw(`drop function if exists spa60_refuse_alias()`))
    }
  })
})

describe('sweepNameSimilarity', () => {
  it('pins the 0.5 threshold against two measured pg_trgm scores', async () => {
    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const funds = await newObject(`Fund ${tag}`, `Funds ${tag}`, me)

    // Above: 0.71 → exactly one open candidate, reason `name_similarity`.
    expect(
      await similarity('accel partners', 'accel partners india'),
    ).toBeCloseTo(0.71, 2)
    const accel = await newRecord(funds.id, 'Accel Partners', me)
    const accelIndia = await newRecord(funds.id, 'Accel Partners India', me)

    const [a, b] = pair(accel.id, accelIndia.id)
    const above = (await candidatesFor(accel.id)).filter(
      (c) => c.entityA === a && c.entityB === b,
    )
    expect(above.length).toBe(1)
    expect(above[0].status).toBe('open')
    expect(Number(above[0].score)).toBeCloseTo(0.71, 2)
    expect(above[0].reason.name_similarity).toBe('accel partners india')

    // Below: 0.40 → nothing. Note it clears pg_trgm's own `%` default of
    // 0.3, so what refuses it is SIMILARITY_THRESHOLD and nothing else.
    expect(await similarity('accel', 'accel partners')).toBeCloseTo(0.4, 2)
    const bare = await newRecord(funds.id, 'Accel', me)
    expect(await candidatesFor(bare.id)).toEqual([])
  })

  it('scopes by object: two objects and a company never pair, byte-identical names included', async () => {
    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const funds = await newObject(`Seed Fund ${tag}`, `Seed Funds ${tag}`, me)
    const vendors = await newObject(`Vendor ${tag}`, `Vendors ${tag}`, me)

    const name = `Northwind Capital ${tag}`
    const fund = await newRecord(funds.id, name, me)
    const vendor = await newRecord(vendors.id, name, me)

    // Same kind (`custom`), same bytes, different object — and a sweep that
    // scoped by kind would have paired them.
    const [fa, fb] = pair(fund.id, vendor.id)
    expect(
      (await candidatesFor(fund.id)).filter(
        (c) => c.entityA === fa && c.entityB === fb,
      ),
    ).toEqual([])

    // A company by the same name is a different object again.
    const { resolveEntity } = await import('./resolve')
    const co = await resolveEntity({
      kind: 'company',
      name,
      source: { class: 'manual' },
    })
    expect(await candidatesFor(co.entityId)).toEqual([])
    expect(await candidatesFor(fund.id)).toEqual([])
    expect(await candidatesFor(vendor.id)).toEqual([])
  })

  it('refuses to suggest a pair merge would throw on — a renamed deal sweeps to nothing', async () => {
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { renameRecordProgram } = await import('./rename')
    const { sweepNameSimilarity } = await import('./sweep')
    const { objectIdForKindAsync } = await import('#/lib/attributes/objects')
    const { normalizeName } = await import('@spaces/core/entities/normalize')
    const { MERGEABLE } = await import('./merge')

    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const dealObjectId = await objectIdForKindAsync('deal')
    const born = async (name: string) => {
      const [row] = await db
        .insert(entity)
        .values({ kind: 'deal', objectId: dealObjectId, canonicalName: name })
        .returning({ id: entity.id })
      return row.id
    }
    const first = await born(`Hyperion Round ${tag}`)
    const second = await born(`Hyperion Round ${tag} placeholder`)

    // Renaming is what gives a deal name aliases (SPA-63), so the old
    // accident — "deals hold no aliases, so the sweep can't see them" — no
    // longer protects anyone.
    const firstName = `Hyperion Series A ${tag}`
    const secondName = `Hyperion Series A ${tag} Extension`
    await Effect.runPromise(
      renameRecordProgram(me, { id: first, name: firstName }),
    )
    await Effect.runPromise(
      renameRecordProgram(me, { id: second, name: secondName }),
    )

    // The pair is over threshold: what stops it is MERGEABLE, not the score.
    expect(MERGEABLE.has('deal')).toBe(false)
    expect(
      await similarity(normalizeName(firstName), normalizeName(secondName)),
    ).toBeGreaterThanOrEqual(0.5)

    const result = await sweepNameSimilarity(second, normalizeName(secondName))
    expect(result.suggested).toBe(0)
    expect(await candidatesFor(second)).toEqual([])
    expect(await candidatesFor(first)).toEqual([])
  })
})
