import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { jsonRecord } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import {
  proposeProgram,
  SuggestionInvalid,
} from '@spaces/core/writes/suggestions/propose'
import type { SuggestionFailure } from '@spaces/core/writes/suggestions/propose'
import { EntityNotFound } from '@spaces/core/writes/attributes/values'
import { canRead } from '@spaces/core/read-policy'
import {
  McpToolQueryFailed,
  McpToolRefused,
  resolveEntityRefProgram,
} from '@spaces/core/writes/read/record'

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

/**
 * Whose canRead applies (`id`), and who the proposal is labelled with: the
 * API token over MCP, or the user and their Ask turn's run in process.
 */
export type ProposeCaller =
  { id: string; tokenId: string } | { id: string; runId: string | null }

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
export const proposableEntity = Effect.fn('proposableEntity')(function* (
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
      // Over MCP the API token is the proposer, an `integration` actor by the
      // token's id (no FK; /inbox joins `api_token` on it). In Ask the user
      // is, with the turn's run, as every in-app AI lane proposes.
      ...('tokenId' in caller
        ? { proposedBy: { type: 'integration' as const, id: caller.tokenId } }
        : {
            proposedBy: { type: 'user' as const, id: caller.id },
            ...(caller.runId === null ? {} : { runId: caller.runId }),
          }),
    }).pipe(Effect.mapError(refusal))
    return {
      suggestionId: row.id,
      entityId,
      status: 'open',
      fields: Object.keys(jsonRecord(row.payload)).sort(),
      note: 'Queued in Review in Spaces. Nothing on the record changes until a person accepts it.',
    }
  },
)
