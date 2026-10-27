import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { duplicateCandidate } from '@spaces/db/schema'
import { SuggestionNotOpen } from '@spaces/core/writes/suggestions/propose'
import { auth } from '#/lib/auth'
import {
  acceptColumnProgram,
  acceptProgram,
  rejectProgram,
  suggestionMessage,
} from '#/lib/ai/propose'
import {
  addProposedOptionProgram,
  attributeRunMessage,
} from '#/lib/ai/attribute-run'
import { applyCardProgram, skipCardProgram } from '#/lib/ask/card-store'
import { askMessage } from '#/lib/ask/threads'
import { heldBeaconSchema } from './held'
import type { HeldDecision } from './held'

/**
 * The server half of the undo hold: the programs a held decision runs, and
 * the beacon route that runs every decision still held when the page went.
 * The server fns behind each verb run these same programs.
 */

export class DuplicateDismissFailed extends Schema.TaggedError<DuplicateDismissFailed>()(
  'DuplicateDismissFailed',
  { message: Schema.String },
) {}

/**
 * Dismiss a duplicate pair. Only an open pair closes, so a pair merged or
 * dismissed meanwhile keeps its own outcome; false when it was not open.
 */
export const dismissDuplicateProgram = Effect.fn('dismissDuplicateProgram')(
  function* (
    candidateId: string,
    actorId: string,
  ): Effect.fn.Return<boolean, DuplicateDismissFailed> {
    const closed = yield* Effect.tryPromise({
      try: () =>
        db
          .update(duplicateCandidate)
          .set({
            status: 'dismissed',
            resolvedBy: actorId,
            resolvedAt: new Date(),
          })
          .where(
            and(
              eq(duplicateCandidate.id, candidateId),
              eq(duplicateCandidate.status, 'open'),
            ),
          )
          .returning({ id: duplicateCandidate.id }),
      catch: () =>
        new DuplicateDismissFailed({ message: 'Could not dismiss the pair' }),
    })
    return closed.length > 0
  },
)

/** How one held decision ended on the server. */
export type HeldOutcome =
  { ok: true; already: boolean } | { ok: false; message: string }

const done = (already: boolean): HeldOutcome => ({ ok: true, already })
const refused = (message: string): HeldOutcome => ({ ok: false, message })

/** Who a held decision runs as; an option is a registry change, admins only. */
export type HeldActor = { id: string; admin: boolean }

/**
 * Run one held decision as the actor, never failing: a decision another hand
 * made first is `already`, a refusal carries the sentence the server fn
 * would have thrown.
 */
export const runHeldDecisionProgram = Effect.fn('runHeldDecisionProgram')(
  function* (decision: HeldDecision, by: HeldActor) {
    const actorId = by.id
    const actor = { type: 'user', id: actorId } as const
    switch (decision.verb) {
      case 'accept':
      case 'dismiss': {
        const r = yield* Effect.result(
          decision.verb === 'accept'
            ? Effect.asVoid(acceptProgram(decision.id, actor))
            : Effect.asVoid(rejectProgram(decision.id, actor)),
        )
        if (r._tag === 'Success') return done(false)
        return r.failure instanceof SuggestionNotOpen
          ? done(true)
          : refused(suggestionMessage(r.failure))
      }
      case 'accept-column': {
        const r = yield* Effect.result(
          acceptColumnProgram({
            attributeSlug: decision.attributeSlug,
            actorId,
            ...(decision.runId === null ? {} : { runId: decision.runId }),
          }),
        )
        return r._tag === 'Success'
          ? done(false)
          : refused(suggestionMessage(r.failure))
      }
      case 'dismiss-duplicate': {
        const r = yield* Effect.result(
          dismissDuplicateProgram(decision.candidateId, actorId),
        )
        return r._tag === 'Success'
          ? done(!r.success)
          : refused(r.failure.message)
      }
      case 'apply-card':
      case 'skip-card': {
        const program =
          decision.verb === 'apply-card' ? applyCardProgram : skipCardProgram
        const r = yield* Effect.result(program(actorId, decision.suggestionId))
        return r._tag === 'Success'
          ? done(false)
          : refused(askMessage(r.failure))
      }
      case 'add-option': {
        if (!by.admin) return refused('Admins only')
        const r = yield* Effect.result(
          addProposedOptionProgram(
            decision.suggestionId,
            decision.label,
            actorId,
          ),
        )
        return r._tag === 'Success'
          ? done(false)
          : refused(attributeRunMessage(r.failure))
      }
    }
  },
)

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * `POST /api/held-decisions`: the signed-in user's session, the body, then
 * each decision in order, one at a time. An anonymous request writes
 * nothing.
 */
export const heldDecisionsResponseProgram = Effect.fn(
  'heldDecisionsResponseProgram',
)(
  function* (request: Request) {
    const session = yield* Effect.tryPromise(() =>
      auth.api.getSession({ headers: request.headers }),
    )
    if (!session) return new Response('Unauthorized', { status: 401 })
    const body = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.map((raw) => heldBeaconSchema.safeParse(raw)),
      Effect.orElseSucceed(() => null),
    )
    if (body === null || !body.success)
      return new Response('Bad request', { status: 400 })
    const outcomes = yield* Effect.forEach(body.data.decisions, (d) =>
      runHeldDecisionProgram(d, {
        id: session.user.id,
        admin: session.user.role === 'admin',
      }),
    )
    return json({ outcomes }, 200)
  },
  Effect.catch(() =>
    Effect.succeed(new Response('Unavailable', { status: 503 })),
  ),
)

/** The route's whole body. */
export const handleHeldDecisionsRequest = (
  request: Request,
): Promise<Response> => Effect.runPromise(heldDecisionsResponseProgram(request))
