import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, suggestion } from '@spaces/db/schema'
import type { suggestionKind } from '@spaces/db/schema'
import type { Json } from '#/lib/json'
import { proposalRefs, toPatch, validateProposal } from '@spaces/core/ai/schema'
import type { ProposalIssue } from '@spaces/core/ai/schema'
import { toObjectKind } from '@spaces/core/attributes/registry'
import type { AttributeDef } from '@spaces/core/attributes/registry'
import { objectIdForKindAsync } from '#/lib/attributes/objects'
import {
  AttributeValidationError,
  EntityNotFound,
  getRegistryByObjectId,
  setValuesInTx,
} from '#/lib/attributes/values'
import type { Actor, SetValuesResult, Tx } from '#/lib/attributes/values'

/**
 * The AI layer's one mutating verb (docs/spec-ai-substrate.md §3, §10).
 *
 * `proposeProgram` writes a `suggestion` row and nothing else — a model, an
 * agent or a prompt injection in a deck can at worst put noise in a queue.
 * `acceptProgram` is the only way a suggestion becomes a value, and it goes
 * through the one write path (`setValuesInTx`) with the **accepter** as
 * actor, `source = 'suggestion'`, and the row's id and refs as the receipt
 * on every `attribute_event`. `rejectProgram` closes a row and writes nothing
 * else.
 *
 * Accept flips the status and writes the value in **one** transaction, and
 * the flip is the guard: `update … set status = 'accepted' where id = $1 and
 * status = 'open' returning *`. Two accepts racing on one row serialize on
 * its lock, the second re-reads `status` after the first commits, matches
 * nothing and is refused — so one accept, one set of events. Any refusal
 * after the flip (an invalid payload, an unsupported kind) rolls the flip
 * back with it, and the row stays `open` for the queue.
 */

export type SuggestionKind = (typeof suggestionKind.enumValues)[number]

/** Only a person accepts or rejects: the decision is what `decided_by` names. */
export type Decider = { type: 'user'; id: string }

export class SuggestionNotFound extends Schema.TaggedError<SuggestionNotFound>()(
  'SuggestionNotFound',
  { id: Schema.String },
) {}

/** Refused: already accepted or rejected — including by a racing accept. */
export class SuggestionNotOpen extends Schema.TaggedError<SuggestionNotOpen>()(
  'SuggestionNotOpen',
  { id: Schema.String, status: Schema.String },
) {}

/** Refused: this kind has no accept path yet. Only `attribute_patch` does. */
export class UnsupportedSuggestionKind extends Schema.TaggedError<UnsupportedSuggestionKind>()(
  'UnsupportedSuggestionKind',
  { id: Schema.String, kind: Schema.String },
) {}

/**
 * The payload does not hold against the record's registry — at propose, or
 * at accept after the registry moved. `message` is the validator's own
 * `slug: detail` lines, joined, so it reads on its own in a toast.
 */
export class SuggestionInvalid extends Schema.TaggedError<SuggestionInvalid>()(
  'SuggestionInvalid',
  {
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({ slug: Schema.String, message: Schema.String }),
    ),
  },
) {}

export class SuggestionWriteFailed extends Schema.TaggedError<SuggestionWriteFailed>()(
  'SuggestionWriteFailed',
  { cause: Schema.Defect() },
) {}

export type SuggestionFailure =
  | SuggestionNotFound
  | SuggestionNotOpen
  | UnsupportedSuggestionKind
  | SuggestionInvalid
  | EntityNotFound
  | SuggestionWriteFailed

const KIND_LABEL: Record<SuggestionKind, string> = {
  attribute_patch: 'field change',
  note: 'note',
  ledger_event: 'ledger event',
  identity: 'identity',
  document_kind: 'document type',
}

const isKind = (k: string): k is SuggestionKind => k in KIND_LABEL

/**
 * The sentence a caller is shown. `Effect.runPromise` rejects with the typed
 * error itself, and a tagged error with no `message` field would otherwise
 * reach a toast as an empty string.
 */
export function suggestionMessage(failure: unknown): string {
  if (failure instanceof SuggestionInvalid) return failure.message
  if (failure instanceof SuggestionNotOpen)
    return `This suggestion was already ${failure.status}`
  if (failure instanceof SuggestionNotFound)
    return 'That suggestion no longer exists'
  if (failure instanceof UnsupportedSuggestionKind)
    return `A suggested ${isKind(failure.kind) ? KIND_LABEL[failure.kind] : failure.kind} cannot be accepted yet`
  if (failure instanceof EntityNotFound) return failure.message
  return 'Could not apply this suggestion'
}

const invalid = (issues: ReadonlyArray<ProposalIssue>) =>
  new SuggestionInvalid({
    message: issues.map((i) => i.message).join('; '),
    issues: issues.map((i) => ({ slug: i.slug, message: i.message })),
  })

type Reader = Tx | typeof db

/** The live registry of the object this record belongs to. */
async function registryFor(
  reader: Reader,
  entityId: string,
): Promise<Array<AttributeDef>> {
  const ent = (
    await reader
      .select({ kind: entity.kind, objectId: entity.objectId })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)
  if (!ent) throw new EntityNotFound({ entityId, message: 'Record not found' })
  if (ent.objectId !== null) return getRegistryByObjectId(ent.objectId)
  const core = toObjectKind(ent.kind)
  if (core === null)
    throw new EntityNotFound({
      entityId,
      message: `No attribute registry for kind ${ent.kind}`,
    })
  return getRegistryByObjectId(await objectIdForKindAsync(core))
}

/** Known refusals pass through; anything else is a write failure. */
const asFailure = (cause: unknown): SuggestionFailure =>
  cause instanceof SuggestionNotFound ||
  cause instanceof SuggestionNotOpen ||
  cause instanceof UnsupportedSuggestionKind ||
  cause instanceof SuggestionInvalid ||
  cause instanceof EntityNotFound
    ? cause
    : cause instanceof AttributeValidationError
      ? invalid([{ slug: cause.slug, message: cause.message }])
      : new SuggestionWriteFailed({ cause })

// ---------- propose ----------

export type ProposeInput = {
  entityId: string
  kind: SuggestionKind
  /** `attribute_patch`: the `Proposal` envelope `{[slug]: {value, refs, confidence}}` */
  payload: Json
  rationale?: string
  /** defaults to the union of the payload's per-field refs for a patch */
  refs?: Array<string>
  runId?: string
  proposedBy: Actor
}

export type Suggestion = typeof suggestion.$inferSelect

export const proposeProgram = Effect.fn('proposeProgram')(function* (
  input: ProposeInput,
): Effect.fn.Return<Suggestion, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: async () => {
      let refs = input.refs ?? []
      // A patch is held to the registry now, so the queue never shows a
      // proposal that could not have been accepted when it was made.
      if (input.kind === 'attribute_patch') {
        const registry = await registryFor(db, input.entityId)
        const checked = validateProposal(registry, input.payload)
        if (!checked.ok) throw invalid(checked.issues)
        refs = input.refs ?? proposalRefs(checked.proposal)
      }
      const row = (
        await db
          .insert(suggestion)
          .values({
            entityId: input.entityId,
            kind: input.kind,
            payload: input.payload,
            rationale: input.rationale ?? null,
            refs,
            runId: input.runId ?? null,
            proposedByType: input.proposedBy.type,
            proposedById:
              input.proposedBy.type === 'system' ? null : input.proposedBy.id,
          })
          .returning()
      ).at(0)
      if (!row) throw new Error('suggestion insert returned no row')
      return row
    },
    catch: asFailure,
  })
})

// ---------- decide ----------

/**
 * The guarded flip, shared by accept and reject. Returns the row only when
 * this call moved it off `open`; otherwise throws the refusal naming why.
 */
async function close(
  tx: Tx,
  id: string,
  status: 'accepted' | 'rejected',
  decider: Decider,
): Promise<Suggestion> {
  const row = (
    await tx
      .update(suggestion)
      .set({ status, decidedBy: decider.id, decidedAt: new Date() })
      .where(and(eq(suggestion.id, id), eq(suggestion.status, 'open')))
      .returning()
  ).at(0)
  if (row) return row
  const held = (
    await tx
      .select({ status: suggestion.status })
      .from(suggestion)
      .where(eq(suggestion.id, id))
  ).at(0)
  if (!held) throw new SuggestionNotFound({ id })
  throw new SuggestionNotOpen({ id, status: held.status })
}

export type Accepted = { suggestion: Suggestion; write: SetValuesResult }

export const acceptProgram = Effect.fn('acceptProgram')(function* (
  id: string,
  actor: Decider,
): Effect.fn.Return<Accepted, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const row = await close(tx, id, 'accepted', actor)
        if (row.kind !== 'attribute_patch')
          throw new UnsupportedSuggestionKind({ id, kind: row.kind })

        // Validated again: the registry the proposal was checked against
        // may have moved (an option archived, an attribute retired).
        const registry = await registryFor(tx, row.entityId)
        const checked = validateProposal(registry, row.payload)
        if (!checked.ok) throw invalid(checked.issues)
        const { patch, claims } = toPatch(registry, checked.proposal)
        // A record_reference is proposed as an identity claim, not an id;
        // resolving it is the identity lane's step, which is not built yet.
        // Refused whole rather than half-applied.
        const unresolved = Object.keys(claims)
        if (unresolved.length > 0)
          throw invalid(
            unresolved.map((slug) => ({
              slug,
              message: `${slug}: a proposed record reference cannot be accepted yet`,
            })),
          )

        const write = await setValuesInTx(tx, {
          entityId: row.entityId,
          patch,
          actor,
          source: 'suggestion',
          suggestionId: row.id,
          refs: row.refs,
        })
        return { suggestion: row, write }
      }),
    catch: asFailure,
  })
})

export const rejectProgram = Effect.fn('rejectProgram')(function* (
  id: string,
  actor: Decider,
): Effect.fn.Return<Suggestion, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: () => db.transaction((tx) => close(tx, id, 'rejected', actor)),
    catch: asFailure,
  })
})
