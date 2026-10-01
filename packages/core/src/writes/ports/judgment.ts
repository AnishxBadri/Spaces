import { Effect, Layer } from 'effect'
import { Judgment, JobPermanent, JobRetryable } from '@spaces/sdk'
import type { JudgmentClaim } from '@spaces/sdk'
import { parseRef } from '../../context/ref'
import { jsonValue } from '../../json'
import type { Json } from '../../json'
import { EntityNotFound } from '../attributes/values'
import { canonicalId } from '../entities/sweep'
import {
  SuggestionInvalid,
  SuggestionWriteFailed,
  proposeProgram,
} from '../suggestions/propose'
import type { ProposeInput, SuggestionFailure } from '../suggestions/propose'
import type { BoundIntegration } from './binding'

/**
 * JudgmentLive (sdk-10; spec-plugin-sdk §4, D52): `Judgment.suggest` lands a
 * proposal in the review inbox — one `suggestion` row per call, through
 * core's one propose writer (`writes/suggestions/propose.ts`), never a value
 * in the graph.
 *
 * - **Provenance is the port's.** `proposed_by_type 'integration'`,
 *   `proposed_by_id` = the bound row's id — from the row, never from the
 *   claim, which carries no proposer field (D52).
 * - **Why travels with it.** The claim's `rationale` and `refs` are written
 *   verbatim; every ref must parse in the shipped grammar (D4,
 *   `context/ref.ts`), or the call fails permanently — a citation the
 *   reviewer cannot follow is the plugin's bug, not a retry.
 * - **Never pre-accepted.** The writer takes no status, so the row is born
 *   in the inbox's initial state (`'open'`) whatever the claim carries.
 * - **An identical open proposal is one row.** An attribute proposal is
 *   deduped by `suggestion_open_integration_unique`; the second call returns
 *   the first call's id.
 *
 * An attribute proposal becomes a one-slug `attribute_patch` held to the
 * record's registry now, as an AI proposal is; a note becomes a `note`
 * drafted from the record itself. A merged-away record is proposed on its
 * survivor.
 */

/**
 * The confidence an integration's proposal carries. The envelope's field is
 * a model's estimate; a provider does not guess, it reports what it holds,
 * so the reviewer reads the rationale and refs rather than a number.
 */
export const INTEGRATION_CONFIDENCE = 1

/** One attribute value an integration proposes, as the writer takes it. */
export const integrationPatch = (input: {
  readonly integrationId: string
  readonly entityId: string
  readonly slug: string
  readonly value: Json
  readonly rationale: string
  readonly refs: ReadonlyArray<string>
}): ProposeInput => ({
  entityId: input.entityId,
  kind: 'attribute_patch',
  payload: {
    [input.slug]: {
      value: input.value,
      refs: [...input.refs],
      confidence: INTEGRATION_CONFIDENCE,
    },
  },
  rationale: input.rationale,
  refs: [...input.refs],
  proposedBy: { type: 'integration', id: input.integrationId },
})

/** A note's title: its first line of text, heading marks stripped. */
const noteTitle = (body: string, rationale: string): string => {
  const first = body
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line !== '')
  return (first ?? rationale.trim()).slice(0, 300)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const failure = (cause: SuggestionFailure) =>
  cause instanceof SuggestionInvalid || cause instanceof EntityNotFound
    ? new JobPermanent({ reason: `Judgment.suggest: ${cause.message}` })
    : new JobRetryable({
        reason: `Judgment.suggest failed: ${cause instanceof SuggestionWriteFailed && cause.cause instanceof Error ? cause.cause.message : cause._tag}`,
      })

/**
 * The claim as the writer takes it. The proposed value is decoded into the
 * column's `Json` (the SDK's is readonly) — a decode, not a cast — and a
 * value that is not JSON is the plugin's bug.
 */
const inputFor = (
  integrationId: string,
  entityId: string,
  claim: JudgmentClaim,
): Effect.Effect<ProposeInput, JobPermanent> => {
  const { proposal, rationale, refs } = claim
  if (proposal.kind === 'note')
    return Effect.succeed({
      entityId,
      kind: 'note',
      payload: {
        title: noteTitle(proposal.body, rationale),
        markdown: proposal.body,
        sourceId: entityId,
      },
      rationale,
      refs: [...refs],
      proposedBy: { type: 'integration', id: integrationId },
    })
  const value = jsonValue.safeParse(proposal.value)
  return value.success
    ? Effect.succeed(
        integrationPatch({
          integrationId,
          entityId,
          slug: proposal.slug,
          value: value.data,
          rationale,
          refs,
        }),
      )
    : Effect.fail(
        new JobPermanent({
          reason: `Judgment.suggest: ${proposal.slug}: the proposed value is not JSON`,
        }),
      )
}

export const JudgmentLive = (
  row: Pick<BoundIntegration, 'id'>,
): Layer.Layer<Judgment> => {
  const suggest = Effect.fn('Judgment.suggest')(function* (
    claim: JudgmentClaim,
  ) {
    if (!UUID.test(claim.entityId)) {
      return yield* new JobPermanent({
        reason: `Judgment.suggest: no record ${claim.entityId}`,
      })
    }
    const unparsed = claim.refs.filter((r) => parseRef(r) === null)
    if (unparsed.length > 0) {
      return yield* new JobPermanent({
        reason: `Judgment.suggest: not a ref: ${unparsed.join(', ')}`,
      })
    }
    const entityId = yield* Effect.tryPromise({
      try: () => canonicalId(claim.entityId),
      catch: (cause) =>
        new JobRetryable({
          reason: `Judgment.suggest failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
    const input = yield* inputFor(row.id, entityId, claim)
    const written = yield* proposeProgram(input).pipe(Effect.mapError(failure))
    return { suggestionId: written.id }
  })

  return Layer.succeed(Judgment, Judgment.of({ suggest }))
}
