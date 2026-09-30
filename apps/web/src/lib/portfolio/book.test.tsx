import { Effect } from 'effect'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PortfolioHeadlineRail,
  PortfolioHeadlineStrip,
} from '#/components/portfolio-headline'

/**
 * Today and Portfolio disagreed about the book (2026-09-30): the dev bench
 * read VALUE $7,048,100 on Today's rail and Current value $5.9M on
 * Portfolio. Both came from the same roll-up — Today had added the realized
 * $1,130,000 to the unrealized $5,918,100 in its own route and called the
 * sum "Value". Since then both surfaces print `portfolioHeadline()` from the
 * one `loadPortfolio()` read, and this pins it on a book with every hazard
 * the bench has: three currencies, one of them with no rate, and a voided
 * mark.
 *
 * Imports of the DB-coupled modules are dynamic like the rest of the suite:
 * `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!actor) throw new Error('fixture user missing')
  return actor.id
}

async function holdingFor(name: string, actor: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const { holding } = await import('@spaces/db/schema/portfolio')
  const [co] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: co.id })
  const [h] = await db
    .insert(holding)
    .values({ companyId: co.id, openedAt: '2024-01-01', createdBy: actor })
    .returning({ id: holding.id })
  return h.id
}

/**
 * Alpha (USD): $100,000 in, marked $300,000, then a $900,000 mark that was
 *   voided, and $50,000 back from a secondary.
 * Bravo (EUR): €200,000 in at 1.10, marked €400,000 at 1.05.
 * Charlie (SGD): S$100,000 in, and the workspace has no SGD rate.
 */
async function seedBook() {
  const { db } = await import('@spaces/db')
  const { distribution, fxRate, investment, mark } =
    await import('@spaces/db/schema/portfolio')
  const { voidLedgerEventProgram } = await import('./reverse')

  const actor = await actorId()
  const alpha = await holdingFor('Alpha Book', actor)
  const bravo = await holdingFor('Bravo Book', actor)
  const charlie = await holdingFor('Charlie Book', actor)

  await db.insert(fxRate).values([
    { currency: 'EUR', date: '2024-05-01', rateToBase: '1.10' },
    { currency: 'EUR', date: '2025-01-01', rateToBase: '1.05' },
  ])
  await db.insert(investment).values([
    {
      holdingId: alpha,
      date: '2024-01-10',
      amount: '100000',
      currency: 'USD',
      instrument: 'priced',
      createdBy: actor,
    },
    {
      holdingId: bravo,
      date: '2024-06-01',
      amount: '200000',
      currency: 'EUR',
      instrument: 'priced',
      createdBy: actor,
    },
    {
      holdingId: charlie,
      date: '2024-03-01',
      amount: '100000',
      currency: 'SGD',
      instrument: 'priced',
      createdBy: actor,
    },
  ])
  const marks = await db
    .insert(mark)
    .values([
      {
        holdingId: alpha,
        date: '2025-01-10',
        fairValue: '300000',
        currency: 'USD',
        basis: 'manual',
        createdBy: actor,
      },
      {
        holdingId: alpha,
        date: '2025-06-01',
        fairValue: '900000',
        currency: 'USD',
        basis: 'manual',
        createdBy: actor,
      },
      {
        holdingId: bravo,
        date: '2025-02-01',
        fairValue: '400000',
        currency: 'EUR',
        basis: 'round_price',
        createdBy: actor,
      },
    ])
    .returning({ id: mark.id, fairValue: mark.fairValue })
  await db.insert(distribution).values({
    holdingId: alpha,
    date: '2025-03-01',
    amount: '50000',
    currency: 'USD',
    kind: 'secondary',
    createdBy: actor,
  })

  // The void goes through the real flow: a compensating row, dated as the
  // original, the original untouched.
  const wrong = marks.find((m) => Number(m.fairValue) === 900000)
  if (!wrong) throw new Error('the mark to void was not written')
  await Effect.runPromise(
    voidLedgerEventProgram(actor, { table: 'mark', id: wrong.id }),
  )
  return { alpha, bravo, charlie }
}

/** One book per file — the harness truncates between files, not tests. */
let seeded: ReturnType<typeof seedBook> | undefined
const book = () => (seeded ??= seedBook())

/** The label → printed value pairs a headline rendered, in order. */
function figures(html: string): Array<[string, string]> {
  const spans = [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(
    (m) => m[1],
  )
  const out: Array<[string, string]> = []
  for (let i = 0; i + 1 < spans.length; i += 2)
    out.push([spans[i], spans[i + 1]])
  return out
}

describe('loadPortfolio — the one book Today and Portfolio read', () => {
  it('converts, drops the voided mark, excludes the unpriced holding, and both surfaces print the same figures', async () => {
    const { loadPortfolio } = await import('./detail')
    const { charlie } = await book()

    const now = await loadPortfolio()
    expect(now.baseCurrency).toBe('USD')
    expect(now.holdings).toHaveLength(3)

    // Alpha: cost 100,000; value 300,000 (the voided 900,000 is gone);
    //   realized 50,000.
    // Bravo: cost 200,000 × 1.10 = 220,000; value 400,000 × 1.05 = 420,000.
    // Charlie: no SGD rate — out of the sums and named, never taken at 1.0.
    expect(now.rollup.costBasis).toBeCloseTo(320_000, 6)
    expect(now.rollup.unrealized).toBeCloseTo(720_000, 6)
    expect(now.rollup.realized).toBeCloseTo(50_000, 6)
    expect(now.rollup.moic).toBeCloseTo(770_000 / 320_000, 9)
    expect(now.rollup.excludedForMissingRates).toEqual([charlie])

    const today = figures(
      renderToStaticMarkup(
        <PortfolioHeadlineRail
          rollup={now.rollup}
          baseCurrency={now.baseCurrency}
        />,
      ),
    )
    const portfolio = figures(
      renderToStaticMarkup(
        <PortfolioHeadlineStrip
          rollup={now.rollup}
          baseCurrency={now.baseCurrency}
        />,
      ),
    )

    // Same figures, same names, same order — only the money's precision is
    // the surface's to choose (Today exact, Portfolio compact).
    expect(today).toEqual([
      ['Invested', '$320,000'],
      ['Current value', '$720,000'],
      ['Realized', '$50,000'],
      ['MOIC', '2.41×'],
    ])
    expect(portfolio).toEqual([
      ['Invested', '$320K'],
      ['Current value', '$720K'],
      ['Realized', '$50K'],
      ['MOIC', '2.41×'],
    ])
    // The old Today rail: realized folded into "Value".
    expect(today.map(([, v]) => v)).not.toContain('$770,000')
  })

  it('reads the voided mark as live at an as-of date before the void', async () => {
    const { loadPortfolio } = await import('./detail')
    await book()

    // The void was written today; on 2025-07-01 nobody had struck the
    // 900,000 mark yet, so it is what the book said then.
    const then = await loadPortfolio('2025-07-01')
    expect(then.rollup.unrealized).toBeCloseTo(900_000 + 420_000, 6)
    expect(then.rollup.costBasis).toBeCloseTo(320_000, 6)
    expect(then.rollup.excludedForMissingRates).toHaveLength(1)
  })
})
