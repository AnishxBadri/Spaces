import { randomUUID } from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  attributeEvent,
  duplicateCandidate,
  entity,
  entityAlias,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { RESOLVE_NEEDS_NAME_OR_KEY, resolveEntity } from '../entities/resolve'
import { setValues, setValuesInTx } from './values'

/**
 * A person's emails and a company's domains are multi-valued identity
 * attributes: every element is an `entity_alias` claim made in the
 * value's own transaction, and an element another record holds is refused
 * at that element while the rest of the patch writes.
 */

const actor = { type: 'user', id: FIXTURE_ACTOR.id } as const

const tag = () => randomUUID().slice(0, 8)

const person = async (name: string, email?: string) =>
  (
    await resolveEntity({
      kind: 'person',
      name: `${name} ${tag()}`,
      ...(email ? { keys: { email } } : {}),
      source: { class: 'manual' },
    })
  ).entityId

const valuesOf = async (id: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)?.values ?? {}

const emailAliases = async (id: string) =>
  (
    await db
      .select({ valueNorm: entityAlias.valueNorm })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.entityId, id),
          eq(entityAlias.kind, 'email'),
          eq(entityAlias.isIdentity, true),
        ),
      )
  )
    .map((a) => a.valueNorm)
    .sort()

const candidatesBetween = async (a: string, b: string) =>
  db
    .select()
    .from(duplicateCandidate)
    .where(
      or(
        and(
          eq(duplicateCandidate.entityA, a),
          eq(duplicateCandidate.entityB, b),
        ),
        and(
          eq(duplicateCandidate.entityA, b),
          eq(duplicateCandidate.entityB, a),
        ),
      ),
    )

describe('emails on a person', () => {
  it('a birth writes the email as a value, an event and an alias', async () => {
    const t = tag()
    const id = await person('Born', `born-${t}@acme.example`)
    expect((await valuesOf(id)).emails).toEqual([`born-${t}@acme.example`])
    expect(await emailAliases(id)).toEqual([`born-${t}@acme.example`])
    const events = await db
      .select({ to: attributeEvent.to })
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, id),
          eq(attributeEvent.attrSlug, 'emails'),
        ),
      )
    expect(events).toEqual([{ to: [`born-${t}@acme.example`] }])
  })

  it('adding one writes value, event and alias together; removing it retires the alias', async () => {
    const t = tag()
    const first = `first-${t}@acme.example`
    const second = `Second-${t}@Acme.example`
    const id = await person('Grid', first)

    const added = await setValues({
      entityId: id,
      patch: { emails: [first, second] },
      actor,
    })
    expect(added.changed).toEqual(['emails'])
    expect(added.identity).toEqual({ emails: 'added' })
    expect(added.identityClaims.emails).toEqual([
      { value: first, outcome: 'already_own' },
      { value: second.toLowerCase(), outcome: 'added' },
    ])
    expect((await valuesOf(id)).emails).toEqual([first, second])
    expect(await emailAliases(id)).toEqual([first, second.toLowerCase()].sort())
    const [event] = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, id),
          eq(attributeEvent.attrSlug, 'emails'),
          eq(attributeEvent.actorType, 'user'),
        ),
      )
    expect(event).toMatchObject({ from: [first], to: [first, second] })

    const removed = await setValues({
      entityId: id,
      patch: { emails: [first] },
      actor,
    })
    expect(removed.identityClaims.emails).toEqual([
      { value: second.toLowerCase(), outcome: 'released' },
      { value: first, outcome: 'already_own' },
    ])
    expect((await valuesOf(id)).emails).toEqual([first])
    expect(await emailAliases(id)).toEqual([first])

    // Clearing the field releases every claim.
    await setValues({ entityId: id, patch: { emails: null }, actor })
    expect((await valuesOf(id)).emails).toBeUndefined()
    expect(await emailAliases(id)).toEqual([])
  })

  it('is one transaction: a write that rolls back leaves no value, event or alias', async () => {
    const t = tag()
    const id = await person('Rolled')
    await expect(
      db.transaction(async (tx) => {
        await setValuesInTx(tx, {
          entityId: id,
          patch: { emails: [`rolled-${t}@acme.example`] },
          actor,
        })
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    expect((await valuesOf(id)).emails).toBeUndefined()
    expect(await emailAliases(id)).toEqual([])
    expect(
      await db
        .select()
        .from(attributeEvent)
        .where(
          and(
            eq(attributeEvent.entityId, id),
            eq(attributeEvent.attrSlug, 'emails'),
          ),
        ),
    ).toEqual([])
  })

  it('refuses an email another person holds at that element, and the rest of the patch lands', async () => {
    const t = tag()
    const held = `held-${t}@acme.example`
    const own = `own-${t}@acme.example`
    const holder = await person('Holder', held)
    const claimant = await person('Claimant')

    const res = await setValues({
      entityId: claimant,
      patch: { emails: [own, held], job_title: 'CTO' },
      actor,
    })
    expect(res.changed.sort()).toEqual(['emails', 'job_title'])
    expect(res.identity).toEqual({ emails: 'suggested_duplicate' })
    expect(res.identityValues).toEqual({ emails: held })
    expect(res.identityClaims.emails).toEqual([
      { value: own, outcome: 'added' },
      { value: held, outcome: 'suggested_duplicate' },
    ])

    const values = await valuesOf(claimant)
    expect(values.emails).toEqual([own])
    expect(values.job_title).toBe('CTO')
    expect(await emailAliases(claimant)).toEqual([own])
    expect(await emailAliases(holder)).toEqual([held])
    const rows = await candidatesBetween(holder, claimant)
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toEqual({ shared: 'email', value: held })
  })

  it('two concurrent saves of one new email: one owner, one candidate, both patches land', async () => {
    const t = tag()
    const shared = `shared-${t}@acme.example`
    const a = await person('Racer A')
    const b = await person('Racer B')

    // A's claim is inserted but uncommitted, so B's check finds nothing and
    // B's insert parks on the unique index until A commits — the 23505 lane.
    let commitA!: () => void
    let aClaimed!: () => void
    const hold = new Promise<void>((resolve) => {
      commitA = resolve
    })
    const claimed = new Promise<void>((resolve) => {
      aClaimed = resolve
    })
    const first = db.transaction(async (tx) => {
      const r = await setValuesInTx(tx, {
        entityId: a,
        patch: { emails: [shared], job_title: 'CEO' },
        actor,
      })
      aClaimed()
      await hold
      return r
    })
    await claimed
    let settled = false
    const second = setValues({
      entityId: b,
      patch: { emails: [shared], job_title: 'COO' },
      actor,
    }).then((r) => {
      settled = true
      return r
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(settled).toBe(false)
    commitA()

    const [ra, rb] = await Promise.all([first, second])
    expect(ra.identity).toEqual({ emails: 'added' })
    expect(rb.identity).toEqual({ emails: 'suggested_duplicate' })
    expect((await valuesOf(a)).emails).toEqual([shared])
    expect((await valuesOf(b)).emails).toBeUndefined()
    expect((await valuesOf(b)).job_title).toBe('COO')
    expect(await emailAliases(a)).toEqual([shared])
    expect(await emailAliases(b)).toEqual([])
    expect(await candidatesBetween(a, b)).toHaveLength(1)

    // And without the staging: two saves at once still leave one owner.
    const other = `other-${t}@acme.example`
    const c = await person('Racer C')
    const d = await person('Racer D')
    await Promise.all([
      setValues({ entityId: c, patch: { emails: [other] }, actor }),
      setValues({ entityId: d, patch: { emails: [other] }, actor }),
    ])
    const owners = [...(await emailAliases(c)), ...(await emailAliases(d))]
    expect(owners).toEqual([other])
    const holders = [await valuesOf(c), await valuesOf(d)].filter((v) =>
      Object.hasOwn(v, 'emails'),
    )
    expect(holders.map((v) => v.emails)).toEqual([[other]])
    expect(await candidatesBetween(c, d)).toHaveLength(1)
  })

  it('de-duplicates on the identity form and keeps the first spelling', async () => {
    const t = tag()
    const id = await person('Dupes')
    await setValues({
      entityId: id,
      patch: {
        emails: [` dup.${t}@gmail.com `, `DUP${t}+news@gmail.com`],
      },
      actor,
    })
    expect((await valuesOf(id)).emails).toEqual([`dup.${t}@gmail.com`])
    expect(await emailAliases(id)).toEqual([`dup${t}@gmail.com`])
  })
})

describe('the free-mail and role-prefix rules hold on the value side', () => {
  it('a role email is stored on a person as a value that claims nothing', async () => {
    const t = tag()
    const id = await person('Role', `jane-${t}@role.example`)
    const result = await setValues({
      entityId: id,
      patch: {
        emails: [`jane-${t}@role.example`, `Info@role-${t}.example`],
      },
      actor,
    })
    expect((await valuesOf(id)).emails).toEqual([
      `jane-${t}@role.example`,
      `Info@role-${t}.example`,
    ])
    expect(result.identityClaims.emails.map((c) => c.value)).toEqual([
      `jane-${t}@role.example`,
    ])
    expect(result.identityAdded).toEqual([])
    // Only the identifying address reaches the identity index.
    expect(await emailAliases(id)).toEqual([`jane-${t}@role.example`])
    const anyAlias = await db
      .select({ valueNorm: entityAlias.valueNorm })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.entityId, id),
          eq(entityAlias.valueNorm, `info@role-${t}.example`),
        ),
      )
    expect(anyAlias).toEqual([])
  })

  it('two people may both carry the same role email, with no duplicate raised', async () => {
    const t = tag()
    const a = await person('Team A')
    const b = await person('Team B')
    for (const id of [a, b])
      await setValues({
        entityId: id,
        patch: { emails: [`team@acme-${t}.example`] },
        actor,
      })
    expect((await valuesOf(a)).emails).toEqual([`team@acme-${t}.example`])
    expect((await valuesOf(b)).emails).toEqual([`team@acme-${t}.example`])
    expect(await candidatesBetween(a, b)).toEqual([])
  })

  it('resolveEntity on a role email resolves no person and creates none', async () => {
    const t = tag()
    const role = `info@acme-${t}.example`
    const holder = await person('Holder')
    await setValues({ entityId: holder, patch: { emails: [role] }, actor })
    const people = async () =>
      (
        await db
          .select({ id: entity.id })
          .from(entity)
          .where(eq(entity.kind, 'person'))
      ).length
    const before = await people()
    await expect(
      resolveEntity({
        kind: 'person',
        keys: { email: role },
        source: { class: 'manual' },
      }),
    ).rejects.toThrow(RESOLVE_NEEDS_NAME_OR_KEY)
    expect(await people()).toBe(before)
    // As a key beside a name it is no claim: the holder is not matched,
    // and the record born from the name does not take the address.
    const named = await resolveEntity({
      kind: 'person',
      name: `Someone ${t}`,
      keys: { email: role },
      source: { class: 'manual' },
    })
    expect(named.action).toBe('created')
    expect(named.entityId).not.toBe(holder)
    expect((await valuesOf(named.entityId)).emails).toBeUndefined()
    expect(await emailAliases(named.entityId)).toEqual([])
  })

  it('a free-mail domain never identifies a company', async () => {
    const t = tag()
    const company = (
      await resolveEntity({
        kind: 'company',
        name: `Free ${t}`,
        keys: { domain: 'gmail.com' },
        source: { class: 'manual' },
      })
    ).entityId
    expect((await valuesOf(company)).domains).toBeUndefined()
    await expect(
      setValues({
        entityId: company,
        patch: { domains: ['gmail.com'] },
        actor,
      }),
    ).rejects.toThrow(/gmail.com never identifies a record/)
  })
})
