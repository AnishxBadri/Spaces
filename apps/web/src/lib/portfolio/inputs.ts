import { z } from 'zod'

/**
 * The portfolio event validators: the server fns' inputs, and what a
 * `ledger_event` suggestion's numbers are held to at accept. One set, so a
 * proposal is refused for exactly what a person typing it would be.
 * - Client-safe: zod only, no db.
 */

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
export const ccy = z.string().length(3).toUpperCase()
export const money = z.number().finite().nonnegative()

export const roundInput = z.object({
  companyId: z.string().uuid(),
  date: isoDate,
  kind: z.string().trim().min(1).max(60),
  raised: money.optional(),
  currency: ccy.optional(),
  preMoney: money.optional(),
  postMoney: money.optional(),
  pricePerShare: money.optional(),
  sharesOutstanding: money.optional(),
  coInvestorIds: z.array(z.string().uuid()).max(50).optional(),
})

export const markInput = z.object({
  holdingId: z.string().uuid(),
  date: isoDate,
  fairValue: money,
  currency: ccy,
  basis: z.enum(['round_price', 'manual', '409a']),
})
