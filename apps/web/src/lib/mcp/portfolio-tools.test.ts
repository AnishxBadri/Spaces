import { Cause, Effect, Exit, Option } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { company, entity } from '@spaces/db/schema'
import {
  distribution,
  fxRate,
  holding,
  investment,
  mark,
} from '@spaces/db/schema/portfolio'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { loadPortfolio } from '#/lib/portfolio/detail'
import { voidLedgerEventProgram } from '#/lib/portfolio/reverse'
import { holdingDetailProgram, portfolioSummaryProgram } from './tools-read'
import type { PortfolioFigures } from './tools-read'

/**
 * `portfolio_summary` and `holding_detail` (D70) over the book Today and
 * Portfolio are pinned on: three currencies, one with no rate, and a voided
 * mark. Then two sensitive holdings join it — one by its company's own flag,
 * one by a deal its check cites — and neither tool shows them.
 */

const actor = FIXTURE_ACTOR.id

async function holdingFor(name: string, sensitive = false) {
  const co = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name, sensitive })
      .returning({ id: entity.id })
  ).at(0)
  if (!co) throw new Error('company not written')
  await db.insert(company).values({ entityId: co.id })
  const h = (
    await db
      .insert(holding)
      .values({ companyId: co.id, openedAt: '2024-01-01', createdBy: actor })
      .returning({ id: holding.id })
  ).at(0)
  if (!h) throw new Error('holding not written')
  return h.id
}

/**
 * Alpha (USD): $100,000 in, marked $300,000, then a $900,000 mark that was
 *   voided, and $50,000 back from a secondary.
 * Bravo (EUR): €200,000 in at 1.10, marked €400,000 at 1.05.
 * Charlie (SGD): S$100,000 in, and the workspace has no SGD rate.
 */
async function seedBook() {
  const alpha = await holdingFor('Alpha Ledger')
  const bravo = await holdingFor('Bravo Ledger')
  const charlie = await holdingFor('Charlie Ledger')
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
  const wrong = marks.find((m) => Number(m.fairValue) === 900000)
  if (!wrong) throw new Error('the mark to void was not written')
  const { reversalId } = await Effect.runPromise(
    voidLedgerEventProgram(actor, { table: 'mark', id: wrong.id }),
  )
  return { alpha, bravo, charlie, voidedMark: wrong.id, reversalId }
}

/**
 * Delta: its company is flagged sensitive. Echo: an ordinary company, but
 * its check cites a sensitive deal.
 */
async function seedSensitive() {
  const delta = await holdingFor('Delta Hushed', true)
  const echo = await holdingFor('Echo Ledger')
  const deal = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: 'Echo Seed', sensitive: true })
      .returning({ id: entity.id })
  ).at(0)
  if (!deal) throw new Error('deal not written')
  await db.insert(investment).values([
    {
      holdingId: delta,
      date: '2024-02-01',
      amount: '70000',
      currency: 'USD',
      instrument: 'priced',
      createdBy: actor,
    },
    {
      holdingId: echo,
      date: '2024-02-01',
      amount: '30000',
      currency: 'USD',
      instrument: 'priced',
      dealId: deal.id,
      createdBy: actor,
    },
  ])
  return { delta, echo }
}

let seeded: ReturnType<typeof seedBook> | undefined
const book = () => (seeded ??= seedBook())
let hushed: ReturnType<typeof seedSensitive> | undefined
const sensitiveToo = () => (hushed ??= book().then(seedSensitive))

const summary = (asOf?: string) =>
  Effect.runPromise(portfolioSummaryProgram({ asOf }))
const detail = (holdingId: string, asOf?: string) =>
  Effect.runPromise(holdingDetailProgram({ holdingId, asOf }))

const cents = (n: number | null) => (n === null ? null : Math.round(n * 100))

/** The page's metrics as the tool names them, in cents. */
function pageFigures(m: {
  currency: string
  costBasis: number
  unrealized: number
  realized: number
  tvpi: number | null
  grossXirr: number | null
}) {
  return {
    currency: m.currency,
    invested: cents(m.costBasis),
    value: cents(m.unrealized),
    distributions: cents(m.realized),
    tvpi: m.tvpi,
    irr: m.grossXirr,
  }
}

const toolFigures = (f: PortfolioFigures) => ({
  currency: f.currency,
  invested: cents(f.invested),
  value: cents(f.value),
  distributions: cents(f.distributions),
  tvpi: f.tvpi,
  irr: f.irr,
})

describe('portfolio_summary', () => {
  it('matches /portfolio’s readouts to the cent, now and as of a past day', async () => {
    const { alpha, bravo, charlie } = await book()
    for (const asOf of [undefined, '2025-07-01', '2024-12-31']) {
      const page = await loadPortfolio(asOf)
      const tool = await summary(asOf)
      expect(tool.asOf).toBe(asOf ?? null)
      expect(tool.baseCurrency).toBe(page.baseCurrency)
      expect(tool.total.currency).toBe('USD')
      expect(cents(tool.total.invested)).toBe(cents(page.rollup.costBasis))
      expect(cents(tool.total.value)).toBe(cents(page.rollup.unrealized))
      expect(cents(tool.total.distributions)).toBe(cents(page.rollup.realized))
      expect(tool.total.tvpi).toBe(page.rollup.moic)
      expect(tool.total.irr).toBe(page.rollup.grossXirr)
      expect(
        tool.total.excludedForMissingRates.map((x) => x.holdingId),
      ).toEqual(page.rollup.excludedForMissingRates)
      expect(tool.holdings.map((h) => h.holdingId)).toEqual(
        page.holdings.map((h) => h.id),
      )
      for (const h of page.holdings) {
        const mine = tool.holdings.find((t) => t.holdingId === h.id)
        if (!h.metrics.ok) {
          expect(mine?.figures).toBeNull()
          expect(mine?.missingRates).toEqual(h.metrics.missingRates)
          continue
        }
        expect(mine?.figures && toolFigures(mine.figures)).toEqual(
          pageFigures(h.metrics.metrics),
        )
      }
    }

    // The figures the page prints, pinned: Invested $320,000, Current value
    // $720,000, Realized $50,000 — the voided $900,000 mark is gone.
    const now = await summary()
    expect(cents(now.total.invested)).toBe(32_000_000)
    expect(cents(now.total.value)).toBe(72_000_000)
    expect(cents(now.total.distributions)).toBe(5_000_000)
    expect(now.total.tvpi).toBeCloseTo(770_000 / 320_000, 12)
    expect(now.total.irr).toEqual(expect.any(Number))
    expect(now.total.excludedForMissingRates).toEqual([
      { holdingId: charlie, companyName: 'Charlie Ledger' },
    ])
    const byId = new Map(now.holdings.map((h) => [h.holdingId, h]))
    expect(byId.get(alpha)?.figures?.currency).toBe('USD')
    expect(byId.get(bravo)?.figures?.currency).toBe('EUR')
    expect(byId.get(bravo)?.figures?.invested).toBe(200_000)
    // Charlie reads natively in SGD; only the base total needs the rate.
    expect(byId.get(charlie)?.figures?.currency).toBe('SGD')
    expect(byId.get(charlie)?.figures?.invested).toBe(100_000)

    // Before the void, the struck mark was what the book said.
    const then = await summary('2025-07-01')
    expect(cents(then.total.value)).toBe(cents(900_000 + 420_000))
  })

  it('returns money as numbers, never the drizzle numeric strings', async () => {
    await book()
    const tool = await summary()
    const figures = [
      tool.total,
      ...tool.holdings.flatMap((h) => (h.figures ? [h.figures] : [])),
    ]
    for (const f of figures)
      for (const v of [f.invested, f.value, f.distributions])
        expect(typeof v).toBe('number')
    // Nothing in the answer is a numeric string.
    const strings: Array<string> = []
    JSON.stringify(tool, (_k, v: unknown) => {
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) strings.push(v)
      return v
    })
    expect(strings).toEqual([])
  })
})

describe('holding_detail', () => {
  it('shows a voided mark as of a day before the void, and neither it nor its negation after', async () => {
    const { alpha, voidedMark, reversalId } = await book()

    const before = await detail(alpha, '2025-07-01')
    expect(before.marks.map((m) => m.fairValue)).toEqual([300_000, 900_000])
    const struck = before.marks.find((m) => m.id === voidedMark)
    expect(struck?.reversedAt).toEqual(expect.any(String))
    expect(before.figures?.value).toBe(900_000)

    for (const after of [
      await detail(alpha),
      await detail(alpha, '2099-01-01'),
    ]) {
      expect(after.marks.map((m) => m.fairValue)).toEqual([300_000])
      expect(after.marks.map((m) => m.id)).not.toContain(voidedMark)
      expect(after.marks.map((m) => m.id)).not.toContain(reversalId)
      expect(after.marks.every((m) => m.reversedAt === null)).toBe(true)
      expect(after.figures?.value).toBe(300_000)
    }

    // An entry dated after the as-of day had not happened yet.
    const early = await detail(alpha, '2025-02-01')
    expect(early.marks.map((m) => m.fairValue)).toEqual([300_000])
    expect(early.distributions).toEqual([])
  })

  it('returns its ledger and figures as numbers with their currency', async () => {
    const { alpha, bravo } = await book()
    const a = await detail(alpha)
    expect(a.investments).toEqual([
      expect.objectContaining({
        date: '2024-01-10',
        amount: 100_000,
        currency: 'USD',
        instrument: 'priced',
        reversedAt: null,
      }),
    ])
    expect(a.distributions).toEqual([
      expect.objectContaining({
        amount: 50_000,
        currency: 'USD',
        kind: 'secondary',
      }),
    ])
    expect(a.figures).toEqual(
      expect.objectContaining({
        currency: 'USD',
        invested: 100_000,
        value: 300_000,
        distributions: 50_000,
      }),
    )
    const b = await detail(bravo)
    expect(b.marks).toEqual([
      expect.objectContaining({ fairValue: 400_000, currency: 'EUR' }),
    ])
    expect(b.figures?.currency).toBe('EUR')
  })
})

describe('sensitive holdings', () => {
  it('are absent from portfolio_summary — rows and total — though the page shows them', async () => {
    const before = await summary()
    const { delta, echo } = await sensitiveToo()

    const page = await loadPortfolio()
    expect(page.holdings.map((h) => h.id)).toEqual(
      expect.arrayContaining([delta, echo]),
    )

    const after = await summary()
    const ids = after.holdings.map((h) => h.holdingId)
    expect(ids).not.toContain(delta)
    expect(ids).not.toContain(echo)
    expect(after.total).toEqual(before.total)
    expect(JSON.stringify(after)).not.toMatch(/Delta Hushed|Echo Ledger/)
  })

  it('refuse in holding_detail exactly as an unknown id does', async () => {
    const { delta, echo } = await sensitiveToo()
    const message = async (holdingId: string) => {
      const exit = await Effect.runPromiseExit(
        holdingDetailProgram({ holdingId }),
      )
      if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
      const failure = Cause.findErrorOption(exit.cause)
      if (Option.isNone(failure) || failure.value._tag !== 'McpToolRefused')
        throw new Error(`expected a refusal, got ${Cause.pretty(exit.cause)}`)
      return failure.value.message
    }
    const unknown = '00000000-0000-4000-8000-000000000000'
    expect(await message(delta)).toBe(
      `No holding ${delta} — portfolio_summary lists them`,
    )
    expect(await message(echo)).toBe(
      `No holding ${echo} — portfolio_summary lists them`,
    )
    expect(await message(unknown)).toBe(
      `No holding ${unknown} — portfolio_summary lists them`,
    )

    // Unflag the company: the holding is back.
    const row = (
      await db
        .select({ companyId: holding.companyId })
        .from(holding)
        .where(eq(holding.id, delta))
    ).at(0)
    if (!row) throw new Error('delta has no row')
    await db
      .update(entity)
      .set({ sensitive: false })
      .where(eq(entity.id, row.companyId))
    expect((await detail(delta)).figures?.invested).toBe(70_000)
  })
})
