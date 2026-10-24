import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entityAlias } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { joinName, splitName } from '../../attributes/person-name'
import { formatPhone, toE164 } from '../../attributes/phone'
import { valueValidator } from '../../attributes/registry'
import { resolveEntity } from '../entities/resolve'
import { renameRecordProgram } from '../entities/rename'
import { AttributeValidationError, setValues } from './values'

/** A person's name parts and `canonical_name`, kept in step by `setValues`. */

async function actorId() {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('no fixture user')
  return row.id
}

async function read(id: string) {
  const row = (
    await db
      .select({ name: entity.canonicalName, values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)
  if (!row) throw new Error('no such entity')
  return row
}

const aPerson = async (name: string) =>
  (await resolveEntity({ kind: 'person', name, source: { class: 'manual' } }))
    .entityId

describe('splitName / joinName', () => {
  it('splits on the last space and joins back', () => {
    expect(splitName('Dana Moreau-Iyer')).toEqual({
      first: 'Dana',
      last: 'Moreau-Iyer',
    })
    expect(splitName('  Jean  Claude Van Damme ')).toEqual({
      first: 'Jean Claude Van',
      last: 'Damme',
    })
    expect(splitName('Prince')).toEqual({ first: 'Prince', last: null })
    expect(splitName('   ')).toEqual({ first: null, last: null })
    expect(joinName('Jean Claude Van', 'Damme')).toBe('Jean Claude Van Damme')
    expect(joinName('Prince', null)).toBe('Prince')
    expect(joinName(null, undefined)).toBe('')
  })
})

describe('setValues keeps canonical_name the join of the parts', () => {
  it('fills the parts at birth from the name the person was born with', async () => {
    const id = await aPerson('Dana Moreau-Iyer')
    const row = await read(id)
    expect(row.values).toMatchObject({
      first_name: 'Dana',
      last_name: 'Moreau-Iyer',
    })
    const single = await read(await aPerson('Prince'))
    expect(single.values.first_name).toBe('Prince')
    expect(single.values).not.toHaveProperty('last_name')
  })

  it('rewrites the name when either part is written', async () => {
    const me = await actorId()
    const id = await aPerson('Dana Moreau')
    await setValues({
      entityId: id,
      patch: { first_name: 'Diana' },
      actor: { type: 'user', id: me },
    })
    expect((await read(id)).name).toBe('Diana Moreau')
    await setValues({
      entityId: id,
      patch: { last_name: 'Moreau-Iyer' },
      actor: { type: 'user', id: me },
    })
    expect((await read(id)).name).toBe('Diana Moreau-Iyer')
    // The name left behind stays findable.
    const aliases = await db
      .select({ value: entityAlias.value })
      .from(entityAlias)
      .where(and(eq(entityAlias.entityId, id), eq(entityAlias.kind, 'name')))
    expect(aliases.map((a) => a.value)).toEqual(
      expect.arrayContaining([
        'Dana Moreau',
        'Diana Moreau',
        'Diana Moreau-Iyer',
      ]),
    )
  })

  it('rewrites the parts when the name is written', async () => {
    const me = await actorId()
    const id = await aPerson('Dana Moreau')
    await setValues({
      entityId: id,
      patch: {},
      name: 'Dana Moreau Iyer',
      actor: { type: 'user', id: me },
    })
    const row = await read(id)
    expect(row.name).toBe('Dana Moreau Iyer')
    expect(row.values).toMatchObject({
      first_name: 'Dana Moreau',
      last_name: 'Iyer',
    })
    // A name that is already the parts' join leaves a hand split alone.
    await setValues({
      entityId: id,
      patch: { first_name: 'Dana', last_name: 'Moreau Iyer' },
      actor: { type: 'user', id: me },
    })
    await setValues({
      entityId: id,
      patch: {},
      name: 'Dana Moreau Iyer',
      actor: { type: 'user', id: me },
    })
    expect((await read(id)).values).toMatchObject({
      first_name: 'Dana',
      last_name: 'Moreau Iyer',
    })
  })

  it('refuses clearing both parts', async () => {
    const me = await actorId()
    const id = await aPerson('Dana Moreau')
    await expect(
      setValues({
        entityId: id,
        patch: { first_name: null, last_name: null },
        actor: { type: 'user', id: me },
      }),
    ).rejects.toThrow(AttributeValidationError)
    expect((await read(id)).name).toBe('Dana Moreau')
  })

  it('a rename through renameRecordProgram splits into the parts', async () => {
    const me = await actorId()
    const id = await aPerson('Dana Moreau')
    await Effect.runPromise(renameRecordProgram(me, { id, name: 'Dana Iyer' }))
    const row = await read(id)
    expect(row.name).toBe('Dana Iyer')
    expect(row.values).toMatchObject({ first_name: 'Dana', last_name: 'Iyer' })
  })
})

describe('phone', () => {
  it('reads E.164 and formats it for display', () => {
    expect(toE164('+91 98450 12345')).toBe('+919845012345')
    expect(toE164('+1 (415) 555-0100')).toBe('+14155550100')
    expect(toE164('415 555 0100')).toBeNull()
    expect(toE164('+1')).toBeNull()
    expect(toE164('+1234567890123456')).toBeNull()
    expect(formatPhone('+14155550100')).toBe('+1 415 555 0100')
    expect(formatPhone('+919845012345')).toBe('+91 98450 12345')
    expect(formatPhone('+3712345678')).toBe('+371 2345 678')
  })

  it('refuses a non-E.164 value naming the shape', () => {
    const single = valueValidator({ type: 'phone', options: {} })
    expect(single.safeParse('+44 7911 123456').data).toBe('+447911123456')
    const refused = single.safeParse('call me')
    expect(refused.error?.issues[0]?.message).toBe(
      'call me is not a phone number — expected + then 2–15 digits, like +14155550100',
    )
    const multi = valueValidator({ type: 'phone', options: { multi: true } })
    expect(multi.safeParse(['+1 415 555 0100', '+14155550100']).data).toEqual([
      '+14155550100',
    ])
    expect(multi.safeParse('+14155550100').success).toBe(false)
    expect(multi.safeParse(['+14155550100', '555-0100']).success).toBe(false)
    // A number the record already holds is kept as written.
    expect(
      valueValidator({ type: 'phone', options: { multi: true } }, [
        '555-0100',
      ]).safeParse(['555-0100', '+14155550100']).data,
    ).toEqual(['555-0100', '+14155550100'])
  })

  it("a person's phone holds several numbers through setValues", async () => {
    const me = await actorId()
    const id = await aPerson('Dana Moreau')
    await setValues({
      entityId: id,
      patch: { phone: ['+91 98450 12345', '+1 415 555 0100'] },
      actor: { type: 'user', id: me },
    })
    expect((await read(id)).values.phone).toEqual([
      '+919845012345',
      '+14155550100',
    ])
    await expect(
      setValues({
        entityId: id,
        patch: { phone: ['98450 12345'] },
        actor: { type: 'user', id: me },
      }),
    ).rejects.toThrow(/expected \+ then 2–15 digits/)
  })
})
