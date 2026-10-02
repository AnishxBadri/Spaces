import { sql } from 'drizzle-orm'
import {
  char,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { entity } from './entities'
import { user } from './auth'

/**
 * The financial engine (CONTEXT.md, "Build record", Portfolio layer).
 * - Every row is an append-only dated event; every aggregate (ownership,
 *   MOIC, XIRR, NAV) is derived at read, never stored.
 * - Money stays in its original currency; conversion is a read-time fx_rate
 *   lookup against the workspace base currency.
 * - A correction is an append: no edit and no delete path. A void is an
 *   exact-negative event citing the original via `reverses_id`, dated as the
 *   original was. `fx_rate` has no reversal — it is a lookup. (D12)
 */

/**
 * One holding per company — the anchor rounds/marks/distributions hang off.
 * Born when a deal reaches Invested (or by bootstrap import). Carries no
 * status/value columns: written-off and exited are derived from events.
 * Cross-vehicle follow-ons land on this one row (workspace = firm doctrine).
 */
export const holding = pgTable(
  'holding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => entity.id),
    openedAt: date('opened_at').notNull(),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('holding_company_unique').on(t.companyId)],
)

/**
 * A financing event in a company — ours or not (rounds we passed on still
 * shape dilution).
 * - `kind` is free text sharing the funding-stage vocabulary, not an enum:
 *   narrowing an enum needs hand-written data deletes.
 * - shares_outstanding is the FULLY DILUTED count post-round.
 */
export const round = pgTable(
  'round',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => entity.id),
    date: date('date').notNull(),
    kind: text('kind').notNull(),
    raised: numeric('raised', { precision: 20, scale: 4 }),
    currency: char('currency', { length: 3 }),
    preMoney: numeric('pre_money', { precision: 20, scale: 4 }),
    postMoney: numeric('post_money', { precision: 20, scale: 4 }),
    pricePerShare: numeric('price_per_share', { precision: 20, scale: 8 }),
    sharesOutstanding: numeric('shares_outstanding', {
      precision: 20,
      scale: 4,
    }),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('round_company_date_idx').on(t.companyId, t.date)],
)

/**
 * Co-investors in a round. A join table rather than `link` because rounds
 * are events, not entities; the co-investor graph still falls out
 * (round → company on one side, investor entity on the other).
 */
export const roundCoInvestor = pgTable(
  'round_co_investor',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => round.id),
    investorEntityId: uuid('investor_entity_id')
      .notNull()
      .references(() => entity.id),
  },
  (t) => [
    uniqueIndex('round_co_investor_unique').on(t.roundId, t.investorEntityId),
  ],
)

/**
 * Instrument subtypes carry ownership semantics: post-money SAFEs lock
 * implied % at signing (amount ÷ cap); pre-money SAFEs and CCDs are
 * cost-basis-only until conversion — a % is never faked.
 */
export const instrument = pgEnum('instrument', [
  'priced',
  'safe_post_money',
  'safe_pre_money',
  'ccd',
])

/**
 * Our checks. deal_id is the pipeline→portfolio seam (nullable: bootstrap
 * imports predate the pipeline). `vehicle` is a label, not tenancy — one
 * optional grouping column so All-funds/Fund-I views need no migration.
 */
export const investment = pgTable(
  'investment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holding.id),
    dealId: uuid('deal_id').references(() => entity.id),
    roundId: uuid('round_id').references(() => round.id),
    date: date('date').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    instrument: instrument('instrument').notNull(),
    shares: numeric('shares', { precision: 20, scale: 4 }),
    cap: numeric('cap', { precision: 20, scale: 4 }),
    discount: numeric('discount', { precision: 7, scale: 4 }),
    vehicle: text('vehicle'),
    /** Set on a compensating event; points at the check it voids (D12). */
    reversesId: uuid('reverses_id').references(
      (): AnyPgColumn => investment.id,
    ),
    /** The bulk-void handle. No FK — nothing owns a batch yet (D12). */
    batchId: uuid('batch_id'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('investment_holding_date_idx').on(t.holdingId, t.date),
    // One reversal per event, enforced by Postgres and not only by the
    // check the void flow makes — two concurrent voids would both pass it.
    uniqueIndex('investment_reverses_unique')
      .on(t.reversesId)
      .where(sql`${t.reversesId} is not null`),
    index('investment_batch_idx').on(t.batchId),
  ],
)

export const markBasis = pgEnum('mark_basis', ['round_price', 'manual', '409a'])

/**
 * Fair value over time, IPEV-aligned: append-only so PORI decays visibly
 * and staleness stays honest — death-is-information applied to valuations.
 */
export const mark = pgTable(
  'mark',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holding.id),
    date: date('date').notNull(),
    fairValue: numeric('fair_value', { precision: 20, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    basis: markBasis('basis').notNull(),
    /** Set on a compensating event; points at the mark it voids (D12). */
    reversesId: uuid('reverses_id').references((): AnyPgColumn => mark.id),
    /** The bulk-void handle. No FK — nothing owns a batch yet (D12). */
    batchId: uuid('batch_id'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('mark_holding_date_idx').on(t.holdingId, t.date),
    uniqueIndex('mark_reverses_unique')
      .on(t.reversesId)
      .where(sql`${t.reversesId} is not null`),
    index('mark_batch_idx').on(t.batchId),
  ],
)

export const distributionKind = pgEnum('distribution_kind', [
  'exit',
  'secondary',
  'dividend',
  'writeoff',
])

/**
 * Realized proceeds. A write-off is one honest click: amount 0, kind
 * 'writeoff'. shares_sold + price_per_share carry divestment math and the
 * ownership delta.
 */
export const distribution = pgTable(
  'distribution',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holding.id),
    date: date('date').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    kind: distributionKind('kind').notNull(),
    sharesSold: numeric('shares_sold', { precision: 20, scale: 4 }),
    pricePerShare: numeric('price_per_share', { precision: 20, scale: 8 }),
    /** Set on a compensating event; points at the row it voids (D12). */
    reversesId: uuid('reverses_id').references(
      (): AnyPgColumn => distribution.id,
    ),
    /** The bulk-void handle. No FK — nothing owns a batch yet (D12). */
    batchId: uuid('batch_id'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('distribution_holding_date_idx').on(t.holdingId, t.date),
    uniqueIndex('distribution_reverses_unique')
      .on(t.reversesId)
      .where(sql`${t.reversesId} is not null`),
    index('distribution_batch_idx').on(t.batchId),
  ],
)

/**
 * Sparse manual rates to the workspace base currency.
 * - Lookup is latest rate ≤ event date; a missing rate is surfaced, never
 *   silently 1.0.
 * - Cash flows convert at transaction-date rates, marks at current/as-of
 *   rates — FX gain/loss lands inside base-currency performance.
 */
export const fxRate = pgTable(
  'fx_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    currency: char('currency', { length: 3 }).notNull(),
    date: date('date').notNull(),
    rateToBase: numeric('rate_to_base', {
      precision: 20,
      scale: 10,
    }).notNull(),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('fx_rate_currency_date_unique').on(t.currency, t.date),
    // A zero or negative rate would silently corrupt every converted
    // aggregate downstream.
    check('fx_rate_positive', sql`${t.rateToBase} > 0`),
  ],
)
