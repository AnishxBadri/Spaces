import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { deriveOptionIds, slugifyOption } from './options'
import type { CreateAttributeInput } from './create'

describe('option ids (pure)', () => {
  it('derives slugs and dedupes with the _2 rule, exactly like the server', () => {
    expect(slugifyOption('Series A+')).toBe('series_a')
    expect(slugifyOption('   ')).toBe('option')
    expect(deriveOptionIds(['High', 'high', 'Low'])).toEqual([
      'high',
      'high_2',
      'low',
    ])
    expect(deriveOptionIds(['High'], ['high'])).toEqual(['high_2'])
  })
})

/** One row of the per-type creation matrix below. */
type CaseInput = Omit<CreateAttributeInput, 'name' | 'createdBy'>

const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('createAttributeProgram', () => {
  const tag = randomUUID().slice(0, 8)
  const name = (t: string) => `Zz ${t} ${tag}`

  afterAll(async () => {
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { like } = await import('drizzle-orm')
    await db.delete(attribute).where(like(attribute.name, `Zz % ${tag}`))
  })

  it('creates every type with its config, default and required flag', async () => {
    const { Effect } = await import('effect')
    const { createAttributeProgram } = await import('./create')
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const base = { objectKind: 'deal' as const, createdBy: actor.id }

    const cases: Array<CaseInput> = [
      { type: 'text', default: 'Untriaged', required: true },
      { type: 'number', config: { precision: 2 } },
      { type: 'currency', config: { code: 'INR' }, default: 5 },
      { type: 'date', default: 'P7D' },
      { type: 'checkbox', default: true, required: true },
      {
        type: 'select',
        options: [{ label: 'Low' }, { label: 'High' }],
        default: 'high',
      },
      {
        type: 'multi_select',
        options: [{ label: 'A' }, { label: 'B' }],
        default: ['a'],
      },
      {
        type: 'status',
        options: [
          { label: 'Open', group: 'active' },
          { label: 'Won', group: 'closed' },
        ],
        default: 'open',
      },
      { type: 'domain' },
      { type: 'email' },
      { type: 'url' },
      { type: 'phone' },
      { type: 'rating', config: { max: 7 }, default: 3 },
      {
        type: 'record_reference',
        config: { targetKind: 'person', multi: true },
      },
      { type: 'actor_reference', default: 'current-user' },
    ]

    for (const c of cases) {
      const { id, slug } = await Effect.runPromise(
        createAttributeProgram({ ...base, name: name(c.type), ...c }),
      )
      const [row] = await db
        .select()
        .from(attribute)
        .where(eq(attribute.id, id))
      const opts = row.options
      expect(slug).toBe(`zz_${c.type}_${tag}`)
      expect(row.isSystem).toBe(false)
      if ('default' in c) expect(opts.default).toEqual(c.default)
      if ('required' in c)
        // checkbox: unchecked is a value, so required is never stored
        expect(opts.required).toBe(c.type === 'checkbox' ? undefined : true)
      if (c.type === 'currency') expect(opts.code).toBe('INR')
      if (c.type === 'rating') expect(opts.max).toBe(7)
      if (c.type === 'number') expect(opts.precision).toBe(2)
      if (c.type === 'record_reference') {
        expect(opts.targetKind).toBe('person')
        expect(opts.multi).toBe(true)
      }
      if (c.type === 'status')
        expect(
          (opts.options ?? []).map((o) => `${o.id}:${o.group ?? ''}`),
        ).toEqual(['open:active', 'won:closed'])
    }
  })

  it('suffixes a colliding slug, rejects bad config and bad defaults', async () => {
    const { Effect } = await import('effect')
    const { createAttributeProgram, AttributeCreateRejected } =
      await import('./create')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const base = { objectKind: 'person' as const, createdBy: actor.id }

    const first = await Effect.runPromise(
      createAttributeProgram({ ...base, name: name('dup'), type: 'text' }),
    )
    const second = await Effect.runPromise(
      createAttributeProgram({ ...base, name: name('dup'), type: 'text' }),
    )
    expect(second.slug).toBe(`${first.slug}_2`)

    const rejects = async (
      input: Parameters<typeof createAttributeProgram>[0],
    ) =>
      expect(Effect.runPromise(createAttributeProgram(input))).rejects.toThrow(
        AttributeCreateRejected,
      )
    await rejects({ ...base, name: name('sel'), type: 'select' })
    await rejects({ ...base, name: name('ref'), type: 'record_reference' })
    await rejects({
      ...base,
      name: name('txt'),
      type: 'text',
      config: { max: 5 },
    })
    await rejects({
      ...base,
      name: name('bad'),
      type: 'select',
      options: [{ label: 'One' }],
      default: 'two',
    })
    await rejects({ ...base, name: name('dt'), type: 'date', default: 'soon' })
  })
})

describe.skipIf(!hasDb)('reorderAttributesProgram', () => {
  const tag = randomUUID().slice(0, 8)

  afterAll(async () => {
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { like } = await import('drizzle-orm')
    await db.delete(attribute).where(like(attribute.name, `Zo % ${tag}`))
  })

  it('persists a full order and ignores ids from other objects', async () => {
    const { Effect } = await import('effect')
    const { createAttributeProgram } = await import('./create')
    const { reorderAttributesProgram } = await import('./update')
    const { getRegistryByObjectId } = await import('./values')
    const { objectIdForKindAsync } = await import('./objects')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const objectId = await objectIdForKindAsync('deal')
    const personObjectId = await objectIdForKindAsync('person')

    const made: Array<string> = []
    for (const n of ['a', 'b', 'c']) {
      const { id } = await Effect.runPromise(
        createAttributeProgram({
          objectId,
          name: `Zo ${n} ${tag}`,
          type: 'text',
          createdBy: actor.id,
        }),
      )
      made.push(id)
    }
    const foreign = await Effect.runPromise(
      createAttributeProgram({
        objectId: personObjectId,
        name: `Zo foreign ${tag}`,
        type: 'text',
        createdBy: actor.id,
      }),
    )
    const [a, b, c] = made

    // Reverse the three, smuggle in another object's attribute: the order
    // lands, the stranger is ignored, and the registry read reflects it.
    await Effect.runPromise(
      reorderAttributesProgram(objectId, [c, foreign.id, b, a]),
    )
    const mine = (await getRegistryByObjectId(objectId))
      .filter((d) => made.includes(d.id))
      .map((d) => d.id)
    expect(mine).toEqual([c, b, a])
    const [foreignRow] = (await getRegistryByObjectId(personObjectId)).filter(
      (d) => d.id === foreign.id,
    )
    expect(foreignRow).toBeTruthy()
  })
})
