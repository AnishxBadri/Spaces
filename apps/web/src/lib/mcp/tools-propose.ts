import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { jsonRecord } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import { proposeProgram, SuggestionInvalid } from '#/lib/ai/propose'
import type { SuggestionFailure } from '#/lib/ai/propose'
import { EntityNotFound } from '@spaces/core/writes/attributes/values'
import { canRead } from '@spaces/core/read-policy'
import {
  McpToolQueryFailed,
  McpToolRefused,
  resolveEntityRefProgram,
} from './tools'

/**
 * The write half of the MCP surface (SPA-31, `docs/spec-ai-substrate.md`
 * §3, §5, §6), and deliberately one verb: `propose_suggestion(entity,
 * patch, rationale, refs)` calls `proposeProgram` — the same one door every
 * in-app feature proposes through. It writes a `suggestion` row and nothing
 * else; a person accepting it in /inbox is what writes a value.
 *
 * The design rule, stated once in §6: an agent is a client of the four
 * contracts. It gets no fifth contract, no privileged write path, no direct
 * DB access. So there is no accept, write, delete or merge tool here, and
 * `acceptProgram` refuses an integration actor (`tools-propose.test.ts`
 * holds both, in the test named for the rule). A prompt injection inside a deck an
 * outside assistant read can at worst propose noise into a queue a person
 * empties.
 *
 * canRead is the token user's, as on the read tools: a record they cannot
 * read (a teammate's private note) is not found — neither proposable nor
 * disclosed.
 */

export type ProposeCaller = {
  /** The token's user — whose canRead applies. */
  id: string
  /** The API token the request authenticated with. */
  tokenId: string
}

export type ProposeSuggestionInput = {
  /** A record id, or a record's exact name. */
  entity: string
  /** The `Proposal` envelope: `{[slug]: {value, refs, confidence}}`. */
  patch: Json
  rationale: string
  /** Defaults to the union of the patch's per-field refs. */
  refs?: Array<string>
}

export type ProposedSuggestion = {
  suggestionId: string
  entityId: string
  status: 'open'
  fields: Array<string>
  note: string
}

const notFound = (ref: string) =>
  new McpToolRefused({ message: `No record ${ref}` })

/**
 * The record a proposal lands on: the one asked for, or its merge survivor,
 * refused as not found when the caller may not read it.
 */
const proposableEntity = Effect.fn('proposableEntity')(function* (
  caller: ProposeCaller,
  ref: string,
): Effect.fn.Return<string, McpToolRefused | McpToolQueryFailed> {
  const id = yield* resolveEntityRefProgram(caller, ref)
  const load = (entityId: string) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({
            id: entity.id,
            mergedIntoId: entity.mergedIntoId,
            visibility: note.visibility,
            authorId: note.authorId,
          })
          .from(entity)
          .leftJoin(note, eq(note.entityId, entity.id))
          .where(eq(entity.id, entityId)),
      catch: (cause) => new McpToolQueryFailed({ cause }),
    }).pipe(Effect.map((rows) => rows.at(0)))
  let row = yield* load(id)
  if (row?.mergedIntoId) row = yield* load(row.mergedIntoId)
  if (!row || !canRead(caller, row)) return yield* notFound(ref.trim())
  return row.id
})

/** A validator refusal reads as the validator wrote it: `slug: detail`. */
const refusal = (
  failure: SuggestionFailure,
): SuggestionFailure | McpToolRefused =>
  failure instanceof SuggestionInvalid
    ? new McpToolRefused({ message: `Proposal refused — ${failure.message}` })
    : failure instanceof EntityNotFound
      ? new McpToolRefused({ message: failure.message })
      : failure

export const proposeSuggestionProgram = Effect.fn('proposeSuggestionProgram')(
  function* (
    caller: ProposeCaller,
    input: ProposeSuggestionInput,
  ): Effect.fn.Return<
    ProposedSuggestion,
    McpToolRefused | McpToolQueryFailed | SuggestionFailure
  > {
    const entityId = yield* proposableEntity(caller, input.entity)
    const rationale = input.rationale.trim()
    const row = yield* proposeProgram({
      entityId,
      kind: 'attribute_patch',
      payload: input.patch,
      ...(rationale ? { rationale } : {}),
      ...(input.refs === undefined ? {} : { refs: input.refs }),
      // The caller is the API token, recorded as an `integration` actor by
      // the token's id. `suggestion.proposed_by_id` carries no FK (one
      // column holds a user id or an integration id), so nothing enforces
      // the pairing yet: the real FK lands when a token is backed by a row
      // of clean's `integration` table (`packages/db/src/schema/
      // integrations.ts`) — the same deferral `attribute_event.actor_id`
      // made before `actor_ref` existed. /inbox names the token by joining
      // `api_token` on this id (`lib/inbox/queue.ts`).
      proposedBy: { type: 'integration', id: caller.tokenId },
    }).pipe(Effect.mapError(refusal))
    return {
      suggestionId: row.id,
      entityId: row.entityId,
      status: 'open',
      fields: Object.keys(jsonRecord(row.payload)).sort(),
      note: 'Queued for review in the Spaces inbox. Nothing on the record changes until a person accepts it.',
    }
  },
)
