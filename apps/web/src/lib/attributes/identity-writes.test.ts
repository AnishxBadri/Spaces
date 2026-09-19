import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The declaration made flesh (spec §9, objects-7): a write to an attribute
 * carrying `options.identityKey` mirrors into `entity_alias` as an identity
 * alias, in the transaction that wrote the value. The doctrine this file
 * pins, line by line:
 *
 * - the alias lands beside the value and its `attribute_event`, stamped with
 *   the provenance the write came through;
 * - a second record claiming the same normalized value gets a
 *   `duplicate_candidate`, keeps its value, and gets no alias — the claim is
 *   withheld from the loser of the race, the field never is;
 * - the unique index firing *between* the check and the insert is the same
 *   answer, because the alias insert sits in a savepoint and only the
 *   savepoint rolls back;
 * - re-writing what you already own is `already_own`, not a second row;
 * - **clearing the value releases the claim** (CONTEXT.md, 2026-09-19) —
 *   name aliases are history and never retire, identity aliases are claims
 *   and do;
 * - and no core object's registry carries a key, because core identity is
 *   core-owned and lives in `entity_alias` already.
 */

const nouns = () => {
  const tag = randomUUID().slice(0, 8)
  return { singular: `Fund ${tag}`, plural: `Funds ${tag}`, tag }
}

/** A custom object with `domain` declared, and the user who declared it. */
async function fundWithDomainKey() {
  const { Effect } = await import('effect')
  const { createObjectProgram } = await import('./object-registry')
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  const object = await Effect.runPromise(
    createObjectProgram({
      ...nouns(),
      identityKeys: ['domain'],
      createdBy: actor.id,
    }),
  )
  return { objectId: object.id, actorId: actor.id }
}

async function makeRecord(
  objectId: string,
  actorId: string,
  name: string,
  values?: Record<string, unknown>,
) {
  const { Effect } = await import('effect')
  const { createRecordProgram } = await import('./object-registry')
  const row = await Effect.runPromise(
    createRecordProgram({
      objectId,
      name,
      ...(values ? { values } : {}),
      actor: { type: 'user', id: actorId },
    }),
  )
  return row.id
}

async function identityAliases(entityId: string) {
  const { db } = await import('@spaces/db')
  const { entityAlias } = await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  return db
    .select({
      kind: entityAlias.kind,
      value: entityAlias.value,
      valueNorm: entityAlias.valueNorm,
      isIdentity: entityAlias.isIdentity,
      sourceClass: entityAlias.sourceClass,
      sourceRef: entityAlias.sourceRef,
    })
    .from(entityAlias)
    .where(
      and(eq(entityAlias.entityId, entityId), eq(entityAlias.isIdentity, true)),
    )
}

async function storedValues(entityId: string) {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const row = (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)
  return row?.values ?? {}
}

async function candidateFor(a: string, b: string) {
  const { db } = await import('@spaces/db')
  const { duplicateCandidate } = await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const [entityA, entityB] = a < b ? [a, b] : [b, a]
  return db
    .select()
    .from(duplicateCandidate)
    .where(
      and(
        eq(duplicateCandidate.entityA, entityA),
        eq(duplicateCandidate.entityB, entityB),
      ),
    )
}

describe('identity-backed attribute writes', () => {
  it('mirrors the value into entity_alias, in the transaction that wrote it', async () => {
    const { setValues } = await import('./values')
    const { db } = await import('@spaces/db')
    const { attributeEvent } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const { objectId, actorId } = await fundWithDomainKey()
    const tag = randomUUID().slice(0, 8)
    const id = await makeRecord(objectId, actorId, `Orbital ${tag}`)

    const res = await setValues({
      entityId: id,
      patch: { domain: `https://www.orbital-${tag}.com/about` },
      actor: { type: 'user', id: actorId },
    })
    expect(res.changed).toEqual(['domain'])
    expect(res.identity).toEqual({ domain: 'added' })

    const aliases = await identityAliases(id)
    expect(aliases.length).toBe(1)
    expect(aliases[0].kind).toBe('domain')
    // The alias is the *normalized* claim, through the same normalizer
    // `resolveEntity` uses; the raw string is kept beside it.
    expect(aliases[0].valueNorm).toBe(`orbital-${tag}.com`)
    expect(aliases[0].value).toBe(`https://www.orbital-${tag}.com/about`)
    // Provenance mirrors the stamp the event row carries: a direct human
    // edit is `manual`, with no integration behind it.
    expect(aliases[0].sourceClass).toBe('manual')
    expect(aliases[0].sourceRef).toBe(null)

    const events = await db
      .select({ to: attributeEvent.to })
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, id),
          eq(attributeEvent.attrSlug, 'domain'),
        ),
      )
    expect(events.length).toBe(1)
  })

  it('a second record claiming the same domain gets a candidate, its value, and no alias', async () => {
    const { setValues } = await import('./values')
    const { objectId, actorId } = await fundWithDomainKey()
    const tag = randomUUID().slice(0, 8)
    const domain = `contested-${tag}.com`
    const holder = await makeRecord(objectId, actorId, `Holder ${tag}`, {
      domain,
    })
    const claimant = await makeRecord(objectId, actorId, `Claimant ${tag}`)

    const res = await setValues({
      entityId: claimant,
      // A different spelling of the same claim — normalization is what
      // makes it a collision at all.
      patch: { domain: `www.${domain}` },
      actor: { type: 'user', id: actorId },
    })
    expect(res.identity).toEqual({ domain: 'suggested_duplicate' })

    // The value is the user's field and always lands.
    expect((await storedValues(claimant)).domain).toBe(`www.${domain}`)
    // Only the claim is withheld.
    expect(await identityAliases(claimant)).toEqual([])
    expect((await identityAliases(holder)).length).toBe(1)

    const rows = await candidateFor(holder, claimant)
    expect(rows.length).toBe(1)
    expect(rows[0].score).toBe(1)
    expect(rows[0].status).toBe('open')
    expect(rows[0].reason).toEqual({ shared: 'domain', value: domain })
  })

  it('a unique violation raised inside the write is a suggestion, not a lost transaction', async () => {
    const { setValues } = await import('./values')
    const { db } = await import('@spaces/db')
    const { entityAlias } = await import('@spaces/db/schema')
    const { objectId, actorId } = await fundWithDomainKey()
    const tag = randomUUID().slice(0, 8)
    const domain = `raced-${tag}.com`
    const rival = await makeRecord(objectId, actorId, `Rival ${tag}`)
    const claimant = await makeRecord(objectId, actorId, `Claimant ${tag}`)

    // Force the race the holder check cannot see: the rival's alias exists
    // but is uncommitted, so our check finds nothing and our insert parks on
    // `alias_identity_unique` until the rival commits — at which point
    // Postgres raises 23505 inside the savepoint.
    let commitRival!: () => void
    let rivalInserted!: () => void
    const held = new Promise<void>((resolve) => {
      commitRival = resolve
    })
    const ready = new Promise<void>((resolve) => {
      rivalInserted = resolve
    })
    const rivalTx = db.transaction(async (tx) => {
      await tx.insert(entityAlias).values({
        entityId: rival,
        kind: 'domain',
        value: domain,
        valueNorm: domain,
        isIdentity: true,
      })
      rivalInserted()
      await held
    })
    await ready

    let settled = false
    const write = setValues({
      entityId: claimant,
      patch: { domain },
      actor: { type: 'user', id: actorId },
    }).then((r) => {
      settled = true
      return r
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    // Parked on the index — which is the proof the check saw nothing and the
    // 23505 lane, not the holder lane, is the one under test.
    expect(settled).toBe(false)
    commitRival()
    await rivalTx

    const res = await write
    expect(res.identity).toEqual({ domain: 'suggested_duplicate' })
    // The savepoint rolled back; the value write did not.
    expect(res.changed).toEqual(['domain'])
    expect((await storedValues(claimant)).domain).toBe(domain)
    expect(await identityAliases(claimant)).toEqual([])

    const rows = await candidateFor(rival, claimant)
    expect(rows.length).toBe(1)
    expect(rows[0].reason).toEqual({ shared: 'domain', value: domain })
  })

  it('re-writing the value you already own is already_own, not a second row', async () => {
    const { setValues } = await import('./values')
    const { objectId, actorId } = await fundWithDomainKey()
    const tag = randomUUID().slice(0, 8)
    const domain = `steady-${tag}.com`
    const id = await makeRecord(objectId, actorId, `Steady ${tag}`, { domain })
    expect((await identityAliases(id)).length).toBe(1)

    const res = await setValues({
      entityId: id,
      patch: { domain },
      actor: { type: 'user', id: actorId },
    })
    // The value did not change, so nothing was logged — but the claim was
    // reconciled, and it is still ours.
    expect(res.changed).toEqual([])
    expect(res.identity).toEqual({ domain: 'already_own' })
    expect((await identityAliases(id)).length).toBe(1)
    expect(await candidateFor(id, id)).toEqual([])
  })

  it('clearing the value releases the claim, and another record may take it', async () => {
    const { setValues } = await import('./values')
    const { objectId, actorId } = await fundWithDomainKey()
    const tag = randomUUID().slice(0, 8)
    const domain = `released-${tag}.com`
    const first = await makeRecord(objectId, actorId, `First ${tag}`, {
      domain,
    })
    expect((await identityAliases(first)).length).toBe(1)

    const cleared = await setValues({
      entityId: first,
      patch: { domain: null },
      actor: { type: 'user', id: actorId },
    })
    expect(cleared.changed).toEqual(['domain'])
    expect(cleared.identity).toEqual({ domain: 'released' })
    // The claim is retired — identity aliases are claims, and a domain
    // nobody asserts is nobody's.
    expect(await identityAliases(first)).toEqual([])

    // Which is the whole point: a second record can now claim it outright.
    const second = await makeRecord(objectId, actorId, `Second ${tag}`)
    const taken = await setValues({
      entityId: second,
      patch: { domain },
      actor: { type: 'user', id: actorId },
    })
    expect(taken.identity).toEqual({ domain: 'added' })
    expect((await identityAliases(second)).length).toBe(1)
    expect(await candidateFor(first, second)).toEqual([])

    // And the first record re-claiming it now meets the second, not itself.
    const again = await setValues({
      entityId: first,
      patch: { domain },
      actor: { type: 'user', id: actorId },
    })
    expect(again.identity).toEqual({ domain: 'suggested_duplicate' })
  })

  it('changing the value retires the claim the old one made', async () => {
    const { setValues } = await import('./values')
    const { objectId, actorId } = await fundWithDomainKey()
    const tag = randomUUID().slice(0, 8)
    const id = await makeRecord(objectId, actorId, `Mover ${tag}`, {
      domain: `before-${tag}.com`,
    })

    const res = await setValues({
      entityId: id,
      patch: { domain: `after-${tag}.com` },
      actor: { type: 'user', id: actorId },
    })
    expect(res.identity).toEqual({ domain: 'added' })
    const aliases = await identityAliases(id)
    expect(aliases.map((a) => a.valueNorm)).toEqual([`after-${tag}.com`])
  })

  it('refuses a value that normalizes to nothing, and only when the key is declared', async () => {
    const { setValues } = await import('./values')
    const { valueValidator } = await import('@spaces/core/attributes/registry')
    const { objectId, actorId } = await fundWithDomainKey()
    const tag = randomUUID().slice(0, 8)
    const id = await makeRecord(objectId, actorId, `Freemail ${tag}`)

    await expect(
      setValues({
        entityId: id,
        patch: { domain: 'gmail.com' },
        actor: { type: 'user', id: actorId },
      }),
    ).rejects.toThrow('domain: gmail.com never identifies a record')
    expect((await storedValues(id)).domain).toBe(undefined)
    expect(await identityAliases(id)).toEqual([])

    // The refinement rides `options.identityKey`, not the type: a plain
    // `domain` attribute is a field like any other and stays permissive.
    const plain = { type: 'domain' as const, options: {} }
    expect(valueValidator(plain).safeParse('gmail.com').success).toBe(true)
    expect(valueValidator(plain).safeParse('not a domain').success).toBe(true)

    const backed = {
      type: 'domain' as const,
      options: { identityKey: 'domain' as const },
    }
    expect(valueValidator(backed).safeParse('gmail.com').success).toBe(false)
    expect(valueValidator(backed).safeParse('acme.io').success).toBe(true)

    // linkedin is backed by a `url` attribute, and refines the same way.
    const linkedin = {
      type: 'url' as const,
      options: { identityKey: 'linkedin' as const },
    }
    expect(
      valueValidator(linkedin).safeParse('https://example.com/team').success,
    ).toBe(false)
    expect(
      valueValidator(linkedin).safeParse('https://www.linkedin.com/in/anish/')
        .success,
    ).toBe(true)
  })

  it('no core object carries an identity key — in the registry or in the database', async () => {
    const { db } = await import('@spaces/db')
    const { attribute, objectDef } = await import('@spaces/db/schema')
    const { eq, sql } = await import('drizzle-orm')
    const { OBJECT_KINDS, SYSTEM_ATTRIBUTES } =
      await import('@spaces/core/attributes/registry')

    for (const kind of OBJECT_KINDS) {
      for (const def of SYSTEM_ATTRIBUTES[kind]) {
        expect(def.options?.identityKey).toBe(undefined)
      }
    }

    const system = await db
      .select({ slug: objectDef.slug, keys: objectDef.identityKeys })
      .from(objectDef)
      .where(eq(objectDef.isSystem, true))
    expect(system.length).toBe(OBJECT_KINDS.length)
    for (const row of system) expect(row.keys).toEqual([])

    const backed = await db
      .select({ slug: attribute.slug })
      .from(attribute)
      .innerJoin(objectDef, eq(objectDef.id, attribute.objectId))
      .where(
        sql`${objectDef.isSystem} and ${attribute.options} ->> 'identityKey' is not null`,
      )
    expect(backed).toEqual([])
  })
})
