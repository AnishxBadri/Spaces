import { Schema, SchemaTransformation } from 'effect'

/**
 * The portfolio event validators: the server fns' inputs, and what a
 * `ledger_event` suggestion's numbers are held to at accept. One set, so a
 * proposal is refused for exactly what a person typing it would be.
 * - Client-safe: Effect Schema only, no db.
 */

const uuid = Schema.String.check(Schema.isUUID())

export const isoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expected YYYY-MM-DD' }),
)
export const ccy = Schema.String.check(Schema.isLengthBetween(3, 3)).pipe(
  Schema.decode(SchemaTransformation.toUpperCase()),
)
export const money = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const roundInput = Schema.Struct({
  companyId: uuid,
  date: isoDate,
  kind: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  raised: Schema.optional(money),
  currency: Schema.optional(ccy),
  preMoney: Schema.optional(money),
  postMoney: Schema.optional(money),
  pricePerShare: Schema.optional(money),
  sharesOutstanding: Schema.optional(money),
  coInvestorIds: Schema.optional(
    Schema.mutable(Schema.Array(uuid)).check(Schema.isMaxLength(50)),
  ),
})

export const markInput = Schema.Struct({
  holdingId: uuid,
  date: isoDate,
  fairValue: money,
  currency: ccy,
  basis: Schema.Literals(['round_price', 'manual', '409a']),
})
