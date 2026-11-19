import { Schema } from 'effect'
import {
  nullable,
  number,
  object,
  oneOf,
  readFirst,
  tagged,
  text,
} from './decode'

/**
 * The `suggestion(kind: 'ledger_event')` payload: a new revision of a bound
 * cap table read against the company's holding.
 * - `proposed` is the portfolio writer's input, minus the company and the
 *   actor: accept validates it with the server fns' own validators, then
 *   appends one `round` or one `mark`. Portfolio history is append-only:
 *   nothing is ever edited.
 * - `before` is the holding as it stood when proposed; `after` is the
 *   ownership the revision reads. The card draws the two as a diff.
 * - One proposal per (document, revision), whatever its status.
 * - Numbers are only shaped here; a negative or off-format one is the
 *   accept-time validators' refusal, so the person sees it and why.
 */

const amount = number()

const nonEmpty = text({ min: 1 })

export const roundProposalSchema = object(
  {
    date: nonEmpty,
    kind: nonEmpty,
    raised: Schema.optional(amount),
    currency: Schema.optional(text()),
    preMoney: Schema.optional(amount),
    postMoney: Schema.optional(amount),
    pricePerShare: Schema.optional(amount),
    sharesOutstanding: Schema.optional(amount),
  },
  { strict: true },
)

export const markProposalSchema = object(
  {
    holdingId: text({ format: 'uuid' }),
    date: nonEmpty,
    fairValue: amount,
    currency: nonEmpty,
    basis: oneOf(['round_price', 'manual', '409a']),
  },
  { strict: true },
)

const beforeSchema = object(
  {
    ownershipPct: nullable(amount),
    fairValue: nullable(amount),
    currency: nullable(text()),
    roundKind: nullable(text()),
    roundDate: nullable(text()),
  },
  { strict: true },
)

const common = {
  companyId: text({ format: 'uuid' }),
  companyName: nonEmpty,
  documentId: text({ format: 'uuid' }),
  documentName: nonEmpty,
  revisionId: nonEmpty,
  before: beforeSchema,
  after: object({ ownershipPct: nullable(amount) }, { strict: true }),
}

export const ledgerEventPayloadSchema = tagged('event', {
  round: object(
    { ...common, event: oneOf(['round']), proposed: roundProposalSchema },
    { strict: true },
  ),
  mark: object(
    { ...common, event: oneOf(['mark']), proposed: markProposalSchema },
    { strict: true },
  ),
})

export type RoundProposal = typeof roundProposalSchema.Type
export type MarkProposal = typeof markProposalSchema.Type
export type LedgerBefore = typeof beforeSchema.Type
export type LedgerEventPayload = typeof ledgerEventPayloadSchema.Type

/** A stored payload read as a ledger event, or null when it is not one. */
export function readLedgerEventPayload(
  raw: unknown,
): LedgerEventPayload | null {
  const parsed = readFirst(ledgerEventPayloadSchema, raw)
  return parsed.success ? parsed.data : null
}
