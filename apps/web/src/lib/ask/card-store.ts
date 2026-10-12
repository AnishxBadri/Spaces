import { Effect, Schema } from 'effect'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  askThread,
  askTurn,
  attributeEvent,
  entity,
  suggestion,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { parseRef } from '@spaces/core/context/ref'
import { jsonRecord, jsonString } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import {
  SuggestionNotOpen,
  acceptProgram,
  proposeProgram,
  registryFor,
  rejectProgram,
  suggestionMessage,
} from '#/lib/ai/propose'
import type { CardDraft } from '#/lib/mcp/tools-cards'
import type { AskCardOutcome, AskCardView } from './cards'
import { askQuery } from './query'
import type { AskQueryFailed } from './query'
import type { AskCallCard, AskRef } from './types'

/**
 * Ask's action cards as stored: each is an open `suggestion` the turn's run
 * proposed, named from the answer's `calls` by `card.suggestionId`. (D70)
 * - Stored when the answer lands, so a card left undecided is already the
 *   Review item it waits as; there is no second store.
 * - Apply is `acceptProgram` with the reader as actor, Skip `rejectProgram`.
 * - The outcome is read back from the writer's receipts: an accepted card
 *   whose writer found nothing to do left none, and reads as not applied.
 * - A stage card whose deal moved since, or closed, is never applied: it
 *   closes unapplied, so neither Apply nor Review can reopen a deal.
 */

/** The stage a `move_stage` card's patch names. */
const stageTarget = (payload: Json): string | null =>
  jsonString(jsonRecord(jsonRecord(payload).stage).value)

export class AskCardRefused extends Schema.TaggedError<AskCardRefused>()(
  'AskCardRefused',
  { message: Schema.String },
) {}

/** A card the turn holds until its answer lands, with its frozen evidence. */
export type HeldCard = {
  callId: string
  draft: CardDraft
  evidence: ReadonlyArray<AskRef>
}

/** What storing a turn's cards left: each card by call, or why not. */
export type StoredCards = {
  cards: Map<string, AskCallCard>
  refused: Map<string, string>
}

/**
 * The turn's cards as open suggestions by the asker, under the turn's run.
 * A card the proposer refuses now (the registry moved mid-turn) is not
 * stored, and its call is refused with the reason.
 */
export const storeCardsProgram = Effect.fn('ask.storeCards')(function* (
  userId: string,
  runId: string,
  held: ReadonlyArray<HeldCard>,
): Effect.fn.Return<StoredCards> {
  const out: StoredCards = { cards: new Map(), refused: new Map() }
  for (const { callId, draft, evidence } of held) {
    // Never stored without evidence: the renderer would refuse it.
    if (evidence.length === 0) {
      out.refused.set(callId, 'A card needs evidence the turn retrieved')
      continue
    }
    const contextRefs = evidence
      .map((e) => e.ref)
      .filter((r) => parseRef(r) !== null)
    const row = yield* proposeProgram({
      entityId: draft.record.id,
      kind: draft.suggestionKind,
      payload: draft.payload,
      rationale: draft.rationale,
      refs: contextRefs,
      runId,
      proposedBy: { type: 'user', id: userId },
    }).pipe(Effect.result)
    if (row._tag === 'Failure') {
      out.refused.set(callId, suggestionMessage(row.failure))
      continue
    }
    out.cards.set(callId, {
      kind: draft.kind,
      suggestionId: row.success.id,
      record: draft.record,
      summary: draft.summary,
      evidence,
      from: draft.from,
    })
  }
  return out
})

/** The cards stored on these calls, each with its outcome read now. */
export const cardViewsProgram = Effect.fn('ask.cardViews')(function* (
  cards: ReadonlyArray<AskCallCard>,
): Effect.fn.Return<Map<string, AskCardView>, AskQueryFailed> {
  if (cards.length === 0) return new Map()
  const ids = cards.map((c) => c.suggestionId)
  const rows = yield* askQuery(() =>
    db
      .select({
        id: suggestion.id,
        kind: suggestion.kind,
        status: suggestion.status,
        rationale: suggestion.rationale,
        payload: suggestion.payload,
      })
      .from(suggestion)
      .where(inArray(suggestion.id, ids)),
  )
  const accepted = rows.filter((r) => r.status === 'accepted').map((r) => r.id)
  // The receipts each writer leaves: a stage event citing the suggestion, a
  // `space.tagged` line naming it. A task always writes.
  const wrote = new Set<string>()
  if (accepted.length > 0) {
    const events = yield* askQuery(() =>
      db
        .selectDistinct({ id: attributeEvent.suggestionId })
        .from(attributeEvent)
        .where(inArray(attributeEvent.suggestionId, accepted)),
    )
    for (const e of events) if (e.id !== null) wrote.add(e.id)
    const tagged = yield* askQuery(() =>
      db
        .select({ id: sql<string>`${activity.meta} ->> 'suggestionId'` })
        .from(activity)
        .where(
          and(
            eq(activity.verb, 'space.tagged'),
            sql`${activity.meta} ->> 'suggestionId' in (${sql.join(
              accepted.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        ),
    )
    for (const t of tagged) wrote.add(t.id)
  }
  // A stage card that did not apply: already there, or the deal moved since.
  const stageDeals = cards
    .filter((c) => c.kind === 'move_stage')
    .map((c) => c.record.id)
  const heldStage = new Map(
    stageDeals.length === 0
      ? []
      : (yield* askQuery(() =>
          db
            .select({ id: entity.id, values: entity.values })
            .from(entity)
            .where(inArray(entity.id, stageDeals)),
        )).map((e) => [e.id, jsonString(e.values.stage)]),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = new Map<string, AskCardView>()
  for (const card of cards) {
    const row = byId.get(card.suggestionId)
    if (row === undefined) continue
    const outcome: AskCardOutcome =
      row.status === 'open'
        ? 'open'
        : row.status === 'rejected'
          ? 'skipped'
          : row.kind === 'task' || wrote.has(row.id)
            ? 'applied'
            : 'conflict'
    out.set(card.suggestionId, {
      id: card.suggestionId,
      kind: card.kind,
      record: card.record,
      summary: card.summary,
      rationale: row.rationale ?? '',
      evidence: card.evidence,
      outcome,
      moved:
        outcome === 'conflict' &&
        card.kind === 'move_stage' &&
        heldStage.get(card.record.id) !== stageTarget(row.payload),
    })
  }
  return out
})

/** The card, if it was proposed in one of the reader's own threads. */
const ownCardProgram = Effect.fn('ask.ownCard')(function* (
  userId: string,
  suggestionId: string,
): Effect.fn.Return<AskCallCard, AskCardRefused | AskQueryFailed> {
  const probe = JSON.stringify([{ card: { suggestionId } }])
  const rows = yield* askQuery(() =>
    db
      .select({ calls: askTurn.calls })
      .from(askTurn)
      .innerJoin(askThread, eq(askThread.id, askTurn.threadId))
      .where(
        and(
          eq(askThread.userId, userId),
          sql`${askTurn.calls} @> ${probe}::jsonb`,
        ),
      )
      .limit(1),
  )
  const card = rows
    .at(0)
    ?.calls.flatMap((c) => (c.card === undefined ? [] : [c.card]))
    .find((c) => c.suggestionId === suggestionId)
  if (card === undefined)
    return yield* new AskCardRefused({ message: 'No such card' })
  return card
})

const viewOf = Effect.fn('ask.cardView')(function* (card: AskCallCard) {
  const view = (yield* cardViewsProgram([card])).get(card.suggestionId)
  if (view === undefined)
    return yield* new AskCardRefused({ message: 'No such card' })
  return view
})

/**
 * Whether a stage card is stale: the deal holds neither the stage it was
 * proposed against nor the one it proposes, or it is closed. Already at the
 * target is not stale; the accept finds nothing to write.
 */
const stageMovedProgram = Effect.fn('ask.stageMoved')(function* (
  card: AskCallCard,
): Effect.fn.Return<boolean, AskQueryFailed> {
  const row = (yield* askQuery(() =>
    db
      .select({ payload: suggestion.payload, values: entity.values })
      .from(suggestion)
      .innerJoin(entity, eq(entity.id, suggestion.entityId))
      .where(eq(suggestion.id, card.suggestionId)),
  )).at(0)
  if (row === undefined) return false
  const held = jsonString(row.values.stage)
  if (held === stageTarget(row.payload)) return false
  const registry = yield* askQuery(() => registryFor(db, card.record.id))
  const closed = registry
    .find((d) => d.slug === 'stage')
    ?.options.options?.some((o) => o.id === held && o.group === 'closed')
  if (closed === true) return true
  return card.from !== undefined && held !== card.from
})

/**
 * Apply: the writer a person would use, as the reader. A card decided
 * meanwhile — in Review, or in another window — reads back as it stands.
 */
export const applyCardProgram = Effect.fn('ask.applyCard')(function* (
  userId: string,
  suggestionId: string,
): Effect.fn.Return<AskCardView, AskCardRefused | AskQueryFailed> {
  const card = yield* ownCardProgram(userId, suggestionId)
  if (card.kind === 'move_stage' && (yield* stageMovedProgram(card))) {
    yield* askQuery(() =>
      db
        .update(suggestion)
        .set({ status: 'accepted', decidedBy: userId, decidedAt: new Date() })
        .where(
          and(eq(suggestion.id, suggestionId), eq(suggestion.status, 'open')),
        ),
    )
    return yield* viewOf(card)
  }
  const done = yield* acceptProgram(suggestionId, {
    type: 'user',
    id: userId,
  }).pipe(Effect.result)
  if (done._tag === 'Failure' && !(done.failure instanceof SuggestionNotOpen))
    return yield* new AskCardRefused({
      message: suggestionMessage(done.failure),
    })
  return yield* viewOf(card)
})

/** Skip: the suggestion closes rejected and nothing else is written. */
export const skipCardProgram = Effect.fn('ask.skipCard')(function* (
  userId: string,
  suggestionId: string,
): Effect.fn.Return<AskCardView, AskCardRefused | AskQueryFailed> {
  const card = yield* ownCardProgram(userId, suggestionId)
  const done = yield* rejectProgram(suggestionId, {
    type: 'user',
    id: userId,
  }).pipe(Effect.result)
  if (done._tag === 'Failure' && !(done.failure instanceof SuggestionNotOpen))
    return yield* new AskCardRefused({
      message: suggestionMessage(done.failure),
    })
  return yield* viewOf(card)
})
