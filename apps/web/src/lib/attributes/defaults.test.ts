import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  addIsoDuration,
  isIsoDuration,
  resolveDefault,
  validateDefault,
} from './defaults'
import { cleanupTestEntities } from '../entities/test-helpers'

const at = new Date('2026-01-31T10:00:00Z')

describe('defaults (pure)', () => {
  it('parses ISO-8601 durations and adds them in UTC calendar terms', () => {
    expect(isIsoDuration('P7D')).toBe(true)
    expect(isIsoDuration('PT0S')).toBe(true)
    expect(isIsoDuration('P')).toBe(false)
    expect(isIsoDuration('tomorrow')).toBe(false)
    expect(addIsoDuration(at, 'P7D').toISOString()).toBe(
      '2026-02-07T10:00:00.000Z',
    )
    expect(addIsoDuration(at, 'P2W').toISOString()).toBe(
      '2026-02-14T10:00:00.000Z',
    )
    // Month arithmetic overflows the way JS dates do — Jan 31 + 1M = Mar 3.
    expect(addIsoDuration(at, 'P1M').toISOString().slice(0, 10)).toBe(
      '2026-03-03',
    )
  })

  it('resolves the two dynamic forms and passes statics through', () => {
    const ctx = { now: at, userId: 'u1' }
    expect(
      resolveDefault(
        { type: 'actor_reference', options: { default: 'current-user' } },
        ctx,
      ),
    ).toBe('u1')
    // No human present: skip silently, the record lands ownerless.
    expect(
      resolveDefault(
        { type: 'actor_reference', options: { default: 'current-user' } },
        { now: at, userId: null },
      ),
    ).toBeUndefined()
    expect(
      resolveDefault({ type: 'date', options: { default: 'P7D' } }, ctx),
    ).toBe('2026-02-07')
    expect(
      resolveDefault({ type: 'date', options: { default: '2027-01-01' } }, ctx),
    ).toBe('2027-01-01')
    expect(
      resolveDefault({ type: 'select', options: { default: 'seed' } }, ctx),
    ).toBe('seed')
    expect(resolveDefault({ type: 'text', options: {} }, ctx)).toBeUndefined()
  })

  it('validates a default in the type’s own write shape at config time', () => {
    const sel = {
      type: 'select' as const,
      options: { options: [{ id: 'a', label: 'A' }] },
    }
    expect(validateDefault(sel, 'a')).toBeNull()
    expect(validateDefault(sel, 'zzz')).toMatch(/./)
    expect(validateDefault({ type: 'date', options: {} }, 'P7D')).toBeNull()
    expect(validateDefault({ type: 'date', options: {} }, 'next week')).toMatch(
      /ISO-8601 duration/,
    )
    expect(validateDefault({ type: 'number', options: {} }, 'x')).toMatch(/./)
    expect(
      validateDefault({ type: 'actor_reference', options: {} }, 'current-user'),
    ).toBeNull()
    expect(validateDefault({ type: 'text', options: {} }, null)).toBeNull()
  })
})

describe('birthValues', () => {
  const tag = randomUUID().slice(0, 8)
  const slug = (t: string) => `dflt_${t}_${tag}`

  afterAll(async () => {
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { like } = await import('drizzle-orm')
    await cleanupTestEntities([`^DfltCo ${tag}( .*)?$`])
    await db.delete(attribute).where(like(attribute.slug, `dflt_%_${tag}`))
  })

  it('fills blanks with resolved defaults, supplied wins, actor is honest', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { objectIdForKindAsync } = await import('./objects')
    const { db } = await import('@spaces/db')
    const { attribute, attributeEvent, entity } =
      await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const objectId = await objectIdForKindAsync('company')

    await db.insert(attribute).values([
      {
        objectId,
        slug: slug('text'),
        name: 'Triage',
        type: 'text',
        options: { default: 'Untriaged' },
      },
      {
        objectId,
        slug: slug('date'),
        name: 'Follow up',
        type: 'date',
        options: { default: 'P7D' },
      },
      {
        objectId,
        slug: slug('owner'),
        name: 'Champion',
        type: 'actor_reference',
        options: { default: 'current-user' },
      },
    ])

    // Dialog path: a human is present, one value supplied.
    const human = await resolveEntity({
      kind: 'company',
      name: `DfltCo ${tag} human`,
      source: 'manual',
      createdBy: actor.id,
      values: { [slug('text')]: 'Hot lead' },
    })
    const [h] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, human.entityId))
    const hv = h.values
    expect(hv[slug('text')]).toBe('Hot lead') // supplied wins, no default
    expect(hv[slug('owner')]).toBe(actor.id) // current-user resolved
    expect(hv[slug('date')]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // duration → date
    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, human.entityId))
    const bySlug = new Map(events.map((e) => [e.attrSlug, e]))
    expect(bySlug.get(slug('text'))?.source).toBe('direct')
    expect(bySlug.get(slug('owner'))?.source).toBe('default')
    expect(bySlug.get(slug('owner'))?.actorType).toBe('user')
    expect(bySlug.get(slug('owner'))?.actorId).toBe(actor.id)
    expect(bySlug.get(slug('date'))?.source).toBe('default')

    // Machine path: no human. Static and duration defaults still fire;
    // current-user skips and the record lands ownerless.
    const machine = await resolveEntity({
      kind: 'company',
      name: `DfltCo ${tag} sync`,
      source: 'import',
    })
    const [m] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, machine.entityId))
    const mv = m.values
    expect(mv[slug('text')]).toBe('Untriaged')
    expect(mv[slug('date')]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(mv[slug('owner')]).toBeUndefined()
    const [mEvent] = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, machine.entityId))
    expect(mEvent.actorType).toBe('integration')
    expect(mEvent.source).toBe('default')
  })

  it('rejects a bad default at attribute save, accepts a good one', async () => {
    const { Effect } = await import('effect')
    const { updateAttributeProgram, AttributeConfigRejected } =
      await import('./update')
    const { objectIdForKindAsync } = await import('./objects')
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const objectId = await objectIdForKindAsync('company')
    const [row] = await db
      .insert(attribute)
      .values({
        objectId,
        slug: slug('select'),
        name: 'Conviction',
        type: 'select',
        options: { options: [{ id: 'unrated', label: 'Unrated' }] },
      })
      .returning({ id: attribute.id })

    await expect(
      Effect.runPromise(
        updateAttributeProgram({ id: row.id, config: { default: 'high' } }),
      ),
    ).rejects.toThrow(AttributeConfigRejected)

    await Effect.runPromise(
      updateAttributeProgram({ id: row.id, config: { default: 'unrated' } }),
    )
    const [saved] = await db
      .select({ options: attribute.options })
      .from(attribute)
      .where(eq(attribute.id, row.id))
    expect(saved.options.default).toBe('unrated')

    await Effect.runPromise(
      updateAttributeProgram({ id: row.id, config: { default: null } }),
    )
    const [cleared] = await db
      .select({ options: attribute.options })
      .from(attribute)
      .where(eq(attribute.id, row.id))
    expect('default' in cleared.options).toBe(false)
  })
})
