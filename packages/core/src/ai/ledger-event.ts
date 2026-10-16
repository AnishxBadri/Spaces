import { z } from 'zod'

/**
 * The `suggestion(kind: 'ledger_event')` payload: a new revision of a bound
 * cap table read against the company's holding (spec-ai-substrate §11).
 * - `proposed` is the portfolio writer's input, minus the company and the
 *   actor: accept validates it with the server fns' own validators, then
 *   appends one `round` or one `mark`. Nothing is ever edited. (D12)
 * - `before` is the holding as it stood when proposed; `after` is the
 *   ownership the revision reads. The card draws the two as a diff.
 * - One proposal per (document, revision), whatever its status.
 * - Numbers are only shaped here; a negative or off-format one is the
 *   accept-time validators' refusal, so the person sees it and why.
 */

const amount = z.number().finite()

export const roundProposalSchema = z
  .object({
    date: z.string().min(1),
    kind: z.string().min(1),
    raised: amount.optional(),
    currency: z.string().optional(),
    preMoney: amount.optional(),
    postMoney: amount.optional(),
    pricePerShare: amount.optional(),
    sharesOutstanding: amount.optional(),
  })
  .strict()

export const markProposalSchema = z
  .object({
    holdingId: z.string().uuid(),
    date: z.string().min(1),
    fairValue: amount,
    currency: z.string().min(1),
    basis: z.enum(['round_price', 'manual', '409a']),
  })
  .strict()

const beforeSchema = z
  .object({
    ownershipPct: amount.nullable(),
    fairValue: amount.nullable(),
    currency: z.string().nullable(),
    roundKind: z.string().nullable(),
    roundDate: z.string().nullable(),
  })
  .strict()

const common = {
  companyId: z.string().uuid(),
  companyName: z.string().min(1),
  documentId: z.string().uuid(),
  documentName: z.string().min(1),
  revisionId: z.string().min(1),
  before: beforeSchema,
  after: z.object({ ownershipPct: amount.nullable() }).strict(),
}

export const ledgerEventPayloadSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...common,
      event: z.literal('round'),
      proposed: roundProposalSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      event: z.literal('mark'),
      proposed: markProposalSchema,
    })
    .strict(),
])

export type RoundProposal = z.infer<typeof roundProposalSchema>
export type MarkProposal = z.infer<typeof markProposalSchema>
export type LedgerBefore = z.infer<typeof beforeSchema>
export type LedgerEventPayload = z.infer<typeof ledgerEventPayloadSchema>

/** A stored payload read as a ledger event, or null when it is not one. */
export function readLedgerEventPayload(
  raw: unknown,
): LedgerEventPayload | null {
  const parsed = ledgerEventPayloadSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
