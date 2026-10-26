import { describe, expect, it } from 'vitest'
import { holdingFigures, holdingSearch, instrumentLabel } from './figures'

/**
 * The holding's figures row and its `?asOf=`: the search keeps an ISO day
 * and drops anything else, a figure prints only with a value, and the day
 * read at recomputes every figure from the same ledger.
 * Dynamic imports: `@spaces/db` builds its pool from `DATABASE_URL` at import
 * time, and the setup file rewrites it per file.
 */

const TODAY = '2026-10-26'

const metrics = {
  currency: 'USD',
  costBasis: 1_000_000,
  unrealized: 1_900_000,
  realized: 0,
  lastMarkDate: '2026-08-30',
  moic: 1.9,
  grossXirr: 0.42,
}

describe('the as-of search', () => {
  it('keeps an ISO day and reads anything else as today', () => {
    expect(holdingSearch.parse({ asOf: '2025-06-30' })).toEqual({
      asOf: '2025-06-30',
    })
    expect(holdingSearch.parse({ asOf: 'yesterday' }).asOf).toBeUndefined()
    expect(holdingSearch.parse({}).asOf).toBeUndefined()
  })
})

describe('the figures', () => {
  it('prints Invested, the marked Value, MOIC and XIRR, and no Realized at 0', () => {
    expect(holdingFigures(metrics, TODAY)).toEqual([
      { label: 'Invested', value: '$1,000,000' },
      { label: 'Value · marked 30 Aug', value: '$1,900,000' },
      { label: 'MOIC', value: '1.90×' },
      { label: 'XIRR', value: '42.0%' },
    ])
  })

  it('prints Realized once something has come back', () => {
    const labels = holdingFigures({ ...metrics, realized: 50_000 }, TODAY).map(
      (f) => f.label,
    )
    expect(labels).toEqual([
      'Invested',
      'Value · marked 30 Aug',
      'Realized',
      'MOIC',
      'XIRR',
    ])
  })

  it('leaves out a figure that cannot be computed yet', () => {
    const labels = holdingFigures(
      { ...metrics, lastMarkDate: null, moic: null, grossXirr: null },
      TODAY,
    ).map((f) => f.label)
    expect(labels).toEqual(['Invested', 'Value · at cost'])
  })

  it('names an instrument as the ledger prints it', () => {
    expect(instrumentLabel('safe_post_money')).toBe('SAFE')
    expect(instrumentLabel('priced')).toBe('Priced')
  })
})

describe('?asOf= on a real holding', () => {
  it('recomputes the figures from the ledger as it stood that day', async () => {
    const { db } = await import('@spaces/db')
    const { company, entity } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { holding, investment, mark } =
      await import('@spaces/db/schema/portfolio')
    const { loadHoldingDetail } = await import('./detail')

    const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!actor) throw new Error('fixture user missing')
    const co = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: 'Asof Robotics' })
        .returning({ id: entity.id })
    ).at(0)
    if (!co) throw new Error('company not written')
    await db.insert(company).values({ entityId: co.id })
    const h = (
      await db
        .insert(holding)
        .values({
          companyId: co.id,
          openedAt: '2024-01-10',
          createdBy: actor.id,
        })
        .returning({ id: holding.id })
    ).at(0)
    if (!h) throw new Error('holding not written')
    await db.insert(investment).values([
      {
        holdingId: h.id,
        date: '2024-01-10',
        amount: '100000',
        currency: 'USD',
        instrument: 'priced',
        createdBy: actor.id,
      },
      {
        holdingId: h.id,
        date: '2025-03-01',
        amount: '50000',
        currency: 'USD',
        instrument: 'priced',
        createdBy: actor.id,
      },
    ])
    await db.insert(mark).values({
      holdingId: h.id,
      date: '2025-06-01',
      fairValue: '600000',
      currency: 'USD',
      basis: 'manual',
      createdBy: actor.id,
    })

    const figuresAt = async (search: Record<string, string>) => {
      const { asOf } = holdingSearch.parse(search)
      const detail = await loadHoldingDetail(h.id, asOf)
      if (!detail.metrics.ok) throw new Error('metrics refused')
      return Object.fromEntries(
        holdingFigures(detail.metrics.metrics, TODAY).map((f) => [
          f.label,
          f.value,
        ]),
      )
    }

    const now = await figuresAt({})
    expect(now['Invested']).toBe('$150,000')
    expect(now['Value · marked 1 Jun 2025']).toBe('$600,000')

    const then = await figuresAt({ asOf: '2024-12-31' })
    expect(then['Invested']).toBe('$100,000')
    expect(Object.keys(then)).not.toContain('Value · marked 1 Jun 2025')
    expect(then['Value · at cost']).toBe('$100,000')
  })
})
