import { Effect, Schema } from 'effect'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, suggestion } from '@spaces/db/schema'
import type { suggestionKind } from '@spaces/db/schema'
import { jsonRecord } from '#/lib/json'
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
 * Accept locks the row, writes the value and flips the status in **one**
 * transaction. The guard is `select … for update` refusing anything not
 * `open`: two accepts racing on one row serialize on its lock, the second
 * reads the status after the first commits and is refused — so one accept,
 * one set of events. Any refusal (an invalid payload, an unsupported kind)
 * rolls the whole transaction back, and the row stays `open` for the queue.
 * A partial accept (SPA-110) is the same transaction ending in a shrunk
 * payload rather than a flip; `acceptProgram` says the rule.
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

export type Reader = Tx | typeof db

/**
 * The live registry of the object this record belongs to. Exported for the
 * deck reader (SPA-90), which compiles the same registry into the schema it
 * hands the model — so the schema and the validator here never disagree.
 */
export async function registryFor(
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

/**
 * Lock one row for its accept and refuse it unless it is still `open`. The
 * `for update` is what serializes two accepts on one row: the second waits
 * for the first to commit, then reads the status — or the shrunk payload —
 * the first left behind.
 */
async function lockOpen(tx: Tx, id: string): Promise<Suggestion> {
  const row = (
    await tx
      .select()
      .from(suggestion)
      .where(eq(suggestion.id, id))
      .for('update')
  ).at(0)
  if (!row) throw new SuggestionNotFound({ id })
  if (row.status !== 'open')
    throw new SuggestionNotOpen({ id, status: row.status })
  return row
}

/** A partial accept: the row stays `open`, holding only what is left. */
async function shrink(
  tx: Tx,
  id: string,
  rest: { [slug: string]: Json },
): Promise<Suggestion> {
  const row = (
    await tx
      .update(suggestion)
      .set({ payload: rest })
      .where(and(eq(suggestion.id, id), eq(suggestion.status, 'open')))
      .returning()
  ).at(0)
  if (!row) throw new SuggestionNotFound({ id })
  return row
}

/**
 * Accept a suggestion, whole or in part.
 *
 * `fields` omitted: every field of the patch, and the row closes
 * `accepted`. `fields` given (the bulk verbs below, SPA-110): only those
 * slugs are validated and written, and the rule for the row is —
 *
 * - no field left once these are applied → it closes `accepted`, the same
 *   guarded flip as a whole accept;
 * - fields left → it stays `open` with the accepted slugs **removed from
 *   its payload**. What was accepted is not lost: every `attribute_event`
 *   the write made carries this row's id as its receipt, so the payload is
 *   exactly what the queue should still show.
 *
 * A refused field rolls its whole transaction back, so the row keeps that
 * field and its `open` status — which is what lets a batch where every item
 * fails leave every suggestion as it found it.
 */
export const acceptProgram = Effect.fn('acceptProgram')(function* (
  id: string,
  actor: Decider,
  fields?: ReadonlyArray<string>,
): Effect.fn.Return<Accepted, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const row = await lockOpen(tx, id)
        if (row.kind !== 'attribute_patch')
          throw new UnsupportedSuggestionKind({ id, kind: row.kind })

        let picked: Json = row.payload
        let rest: { [slug: string]: Json } = {}
        if (fields !== undefined) {
          const envelope = jsonRecord(row.payload)
          const absent = fields.filter((slug) => !(slug in envelope))
          if (fields.length === 0 || absent.length > 0)
            throw invalid(
              (fields.length === 0 ? ['fields'] : absent).map((slug) => ({
                slug,
                message: `${slug}: not proposed by this suggestion`,
              })),
            )
          const chosen = new Set(fields)
          const entries = Object.entries(envelope)
          picked = Object.fromEntries(entries.filter(([s]) => chosen.has(s)))
          rest = Object.fromEntries(entries.filter(([s]) => !chosen.has(s)))
        }

        // Validated again: the registry the proposal was checked against
        // may have moved (an option archived, an attribute retired).
        const registry = await registryFor(tx, row.entityId)
        const checked = validateProposal(registry, picked)
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
        const decided =
          Object.keys(rest).length === 0
            ? await close(tx, id, 'accepted', actor)
            : await shrink(tx, id, rest)
        return { suggestion: decided, write }
      }),
    catch: asFailure,
  })
})

// ---------- bulk accept (SPA-110, spec §10 "bulk accept per column/list") ----------

/**
 * One item of a batch: one field of a suggestion, or — for a kind that is
 * not a patch — the whole suggestion, when `slug` is absent.
 */
export type BatchOutcome =
  | { suggestionId: string; slug?: string; ok: true }
  | { suggestionId: string; slug?: string; ok: false; message: string }

type BatchItem = { suggestionId: string; slug?: string }

/**
 * Accept each item through `acceptProgram`, one at a time, each in its own
 * transaction.
 *
 * **Never one transaction around the batch.** A partial accept is a real
 * outcome the queue must be able to show: four fields that validate are
 * four values the person asked for, and one option archived since the
 * proposal must neither roll them back nor abort the fields after it. One
 * transaction would make the batch all-or-nothing — the behaviour this verb
 * exists to replace. Sequential rather than concurrent because two items
 * are often fields of one row and would queue on its lock anyway.
 */
const acceptEach = Effect.fn('acceptEach')(function* (
  items: ReadonlyArray<BatchItem>,
  actor: Decider,
): Effect.fn.Return<Array<BatchOutcome>> {
  return yield* Effect.forEach(items, (item) =>
    Effect.result(
      acceptProgram(
        item.suggestionId,
        actor,
        item.slug === undefined ? undefined : [item.slug],
      ),
    ).pipe(
      Effect.map((r): BatchOutcome => {
        const base: BatchItem =
          item.slug === undefined
            ? { suggestionId: item.suggestionId }
            : { suggestionId: item.suggestionId, slug: item.slug }
        return r._tag === 'Success'
          ? { ...base, ok: true }
          : { ...base, ok: false, message: suggestionMessage(r.failure) }
      }),
    ),
  )
})

const read = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: asFailure })

/**
 * "Accept all on this record": every open suggestion on it, oldest first
 * (a later proposal for the same field lands last, and wins), field by
 * field for a patch — so one bad field is one failed item and the others
 * land. A kind with no accept path is one item, refused by name.
 */
export const acceptRecordProgram = Effect.fn('acceptRecordProgram')(
  function* (input: {
    entityId: string
    actorId: string
  }): Effect.fn.Return<Array<BatchOutcome>, SuggestionFailure> {
    const rows = yield* read(() =>
      db
        .select({
          id: suggestion.id,
          kind: suggestion.kind,
          payload: suggestion.payload,
        })
        .from(suggestion)
        .where(
          and(
            eq(suggestion.entityId, input.entityId),
            eq(suggestion.status, 'open'),
          ),
        )
        .orderBy(asc(suggestion.createdAt), asc(suggestion.id)),
    )
    const items = rows.flatMap((r): Array<BatchItem> => {
      const slugs =
        r.kind === 'attribute_patch' ? Object.keys(jsonRecord(r.payload)) : []
      return slugs.length > 0
        ? slugs.map((slug) => ({ suggestionId: r.id, slug }))
        : [{ suggestionId: r.id }]
    })
    return yield* acceptEach(items, { type: 'user', id: input.actorId })
  },
)

/**
 * "Accept this column": one attribute across every open patch that
 * proposes it, whatever record it is on. Only that field of each row is
 * accepted; the row's other fields stay open for their own decision.
 */
export const acceptColumnProgram = Effect.fn('acceptColumnProgram')(
  function* (input: {
    attributeSlug: string
    actorId: string
  }): Effect.fn.Return<Array<BatchOutcome>, SuggestionFailure> {
    const rows = yield* read(() =>
      db
        .select({ id: suggestion.id })
        .from(suggestion)
        .where(
          and(
            eq(suggestion.status, 'open'),
            eq(suggestion.kind, 'attribute_patch'),
            sql`(${suggestion.payload} -> ${input.attributeSlug}) is not null`,
          ),
        )
        .orderBy(asc(suggestion.createdAt), asc(suggestion.id)),
    )
    return yield* acceptEach(
      rows.map((r) => ({ suggestionId: r.id, slug: input.attributeSlug })),
      { type: 'user', id: input.actorId },
    )
  },
)

export const rejectProgram = Effect.fn('rejectProgram')(function* (
  id: string,
  actor: Decider,
): Effect.fn.Return<Suggestion, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: () => db.transaction((tx) => close(tx, id, 'rejected', actor)),
    catch: asFailure,
  })
})
