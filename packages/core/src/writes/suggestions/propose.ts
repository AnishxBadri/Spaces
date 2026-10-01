import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, suggestion } from '@spaces/db/schema'
import type { suggestionKind } from '@spaces/db/schema'
import type { Json } from '../../json'
import { proposalRefs, validateProposal } from '../../ai/schema'
import type { ProposalIssue } from '../../ai/schema'
import { identityPayloadSchema } from '../../ai/identity'
import { documentKindPayloadSchema } from '../../ai/document-kind'
import { notePayloadSchema } from '../../ai/note'
import { spaceTagPayloadSchema } from '../../ai/space-tag'
import { toObjectKind } from '../../attributes/registry'
import type { AttributeDef } from '../../attributes/registry'
import { objectIdForKindAsync } from '../attributes/objects'
import {
  AttributeValidationError,
  EntityNotFound,
  getRegistryByObjectId,
} from '../attributes/values'
import type { Actor, Tx } from '../attributes/values'
import { captureObjectOfRun } from '../ai/capture-read'
import type { CaptureObject } from '../ai/capture-read'

/**
 * The write half of the AI layer's one mutating verb
 * (docs/spec-ai-substrate.md §3, §10): `proposeProgram` writes a
 * `suggestion` row and nothing else — a model, an agent, a plugin or a
 * prompt injection in a deck can at worst put noise in a queue.
 *
 * Moved here from `apps/web/src/lib/ai/propose.ts` by SPA-204 (sdk-10) so
 * the plugin ports reach it: `Judgment.suggest` and `Facts.fill`'s conflicts
 * (`writes/ports/judgment.ts`, `writes/ports/facts.ts`) both land here.
 * apps/web re-exports everything below under its old names. The accept path
 * — `acceptProgram`, the batch accepts, `rejectProgram` — stays in apps/web:
 * it writes notes and space tags through modules that have not left it.
 *
 * **A row is born open.** Nothing here takes a status: the column's default
 * (`'open'`) is the only one an insert can get, so no caller — and no port —
 * can propose a suggestion already accepted.
 *
 * **An integration's identical open proposal is one row** (SPA-204):
 * `suggestion_open_integration_unique` keys open `attribute_patch` rows from
 * `'integration'` proposers on (record, slugs, values). The insert is
 * `ON CONFLICT DO NOTHING`, and a refused insert hands back the row already
 * held — so a plugin re-run raises nothing new, decided by the database and
 * not by a read before the write.
 */

export type SuggestionKind = (typeof suggestionKind.enumValues)[number]

export class SuggestionNotFound extends Schema.TaggedError<SuggestionNotFound>()(
  'SuggestionNotFound',
  { id: Schema.String },
) {}

/** Refused: already accepted or rejected — including by a racing accept. */
export class SuggestionNotOpen extends Schema.TaggedError<SuggestionNotOpen>()(
  'SuggestionNotOpen',
  { id: Schema.String, status: Schema.String },
) {}

/**
 * Refused: this kind has no accept path yet. `attribute_patch` and
 * `identity` do.
 */
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

export const invalid = (issues: ReadonlyArray<ProposalIssue>) =>
  new SuggestionInvalid({
    message: issues.map((i) => i.message).join('; '),
    issues: issues.map((i) => ({ slug: i.slug, message: i.message })),
  })

/** Known refusals pass through; anything else is a write failure. */
export const asFailure = (cause: unknown): SuggestionFailure =>
  cause instanceof SuggestionNotFound ||
  cause instanceof SuggestionNotOpen ||
  cause instanceof UnsupportedSuggestionKind ||
  cause instanceof SuggestionInvalid ||
  cause instanceof EntityNotFound
    ? cause
    : cause instanceof AttributeValidationError
      ? invalid([{ slug: cause.slug, message: cause.message }])
      : new SuggestionWriteFailed({ cause })

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

/**
 * What a patch on this entity is held to, and — for a captured page — the
 * object it was read against (SPA-134). A record is its own anchor and its
 * own registry. A document holds a patch only when a capture read wrote it:
 * its run names the object, and that object's live registry is the one the
 * model was handed, so propose and accept validate against what was read.
 */
export async function patchAnchor(
  reader: Reader,
  entityId: string,
  runId: string | null,
): Promise<{
  registry: Array<AttributeDef>
  page: CaptureObject | null
}> {
  const ent = (
    await reader
      .select({ kind: entity.kind })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)
  if (ent?.kind !== 'document')
    return { registry: await registryFor(reader, entityId), page: null }
  const page = await captureObjectOfRun(reader, runId)
  if (page === null)
    throw new EntityNotFound({
      entityId,
      message: 'A document takes a field change only from a captured page read',
    })
  return { registry: await getRegistryByObjectId(page.id), page }
}

/** An identity payload, decoded — or the validator's refusal, by field. */
export function identityOf(payload: Json) {
  const parsed = identityPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'identity'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/** A document-kind payload, decoded — or the validator's refusal. */
export function documentKindOf(payload: Json) {
  const parsed = documentKindPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'document_kind'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/** A note payload, decoded — or the validator's refusal, by field. */
export function noteOf(payload: Json) {
  const parsed = notePayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'note'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/** A space-tag payload, decoded — or the validator's refusal. */
export function spaceTagOf(payload: Json) {
  const parsed = spaceTagPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'space_tag'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

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

/**
 * The open row `suggestion_open_integration_unique` refused this insert
 * for: same record, same kind, an integration's, and the same slugs and
 * values by the index's own expressions — so the lookup can only find the
 * row the index compared against.
 */
async function heldOpen(
  reader: Reader,
  entityId: string,
  payload: Json,
): Promise<Suggestion | undefined> {
  const proposed = JSON.stringify(payload)
  return (
    await reader
      .select()
      .from(suggestion)
      .where(
        and(
          eq(suggestion.entityId, entityId),
          eq(suggestion.status, 'open'),
          eq(suggestion.kind, 'attribute_patch'),
          eq(suggestion.proposedByType, 'integration'),
          sql`jsonb_path_query_array(${suggestion.payload}, '$.keyvalue().key') = jsonb_path_query_array(${proposed}::jsonb, '$.keyvalue().key')`,
          sql`md5(jsonb_path_query_array(${suggestion.payload}, '$.*.value')::text) = md5(jsonb_path_query_array(${proposed}::jsonb, '$.*.value')::text)`,
        ),
      )
  ).at(0)
}

/**
 * Validate a proposal and insert it, on `reader` — `db`, or a caller's
 * transaction when the suggestion must commit with something else (a
 * `Facts.fill` conflict commits with the fill that refused it). Throws the
 * typed refusals `asFailure` passes through. An integration's identical
 * open proposal already held is returned rather than duplicated.
 */
export async function proposeWith(
  reader: Reader,
  input: ProposeInput,
): Promise<Suggestion> {
  let refs = input.refs ?? []
  // A patch is held to the registry now, so the queue never shows a
  // proposal that could not have been accepted when it was made.
  if (input.kind === 'attribute_patch') {
    const { registry } = await patchAnchor(
      reader,
      input.entityId,
      input.runId ?? null,
    )
    const checked = validateProposal(registry, input.payload)
    if (!checked.ok) throw invalid(checked.issues)
    refs = input.refs ?? proposalRefs(checked.proposal)
  }
  // An identity is held to its shape now for the same reason: the card
  // draws it field by field, and the accept path resolves from it.
  if (input.kind === 'identity') identityOf(input.payload)
  // A document kind likewise (SPA-62): never `other`, never off-enum.
  if (input.kind === 'document_kind') documentKindOf(input.payload)
  // A note (SPA-66) likewise: the card draws its title and body, and
  // the accept path renders the body into the note it writes.
  if (input.kind === 'note') noteOf(input.payload)
  // A space tag likewise (SPA-103): a space id and the path it was read as.
  if (input.kind === 'space_tag') spaceTagOf(input.payload)
  const row = (
    await reader
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
      // The only unique index a fresh row can collide with is the open
      // integration proposal's (the id is minted by the database).
      .onConflictDoNothing()
      .returning()
  ).at(0)
  if (row) return row
  const held = await heldOpen(reader, input.entityId, input.payload)
  // Decided between the refused insert and this read: the next try inserts.
  if (!held) throw new Error('an identical open suggestion closed mid-insert')
  return held
}

export const proposeProgram = Effect.fn('proposeProgram')(function* (
  input: ProposeInput,
): Effect.fn.Return<Suggestion, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: () => proposeWith(db, input),
    catch: asFailure,
  })
})
