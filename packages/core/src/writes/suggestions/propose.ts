import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  entity,
  space,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import type { suggestionKind } from '@spaces/db/schema'
import type { Json } from '../../json'
import { proposalRefs, validateProposal } from '../../ai/schema'
import type { ProposalIssue } from '../../ai/schema'
import { identityPayloadSchema } from '../../ai/identity'
import { documentKindPayloadSchema } from '../../ai/document-kind'
import { notePayloadSchema } from '../../ai/note'
import { spaceTagPayloadSchema } from '../../ai/space-tag'
import { taskPayloadSchema } from '../../ai/task'
import type { TaskPayload } from '../../ai/task'
import {
  MAX_EVIDENCE,
  MAX_WATCHES,
  addRecordPayloadSchema,
  evidenceOf,
  fileRecordPayloadSchema,
} from '../../ai/discovery'
import type { AddRecordPayload, FileRecordPayload } from '../../ai/discovery'
import { normalizeDomain } from '../../entities/normalize'
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

/** The two cards a space's watch hands back; proposed by `proposeDiscoveryWith`. */
export type DiscoveryKind = 'add_record' | 'file_record'

export const DISCOVERY_KINDS: ReadonlyArray<DiscoveryKind> = [
  'add_record',
  'file_record',
]

/** Every kind anchored on a record; proposed by `proposeWith`. */
export type RecordKind = Exclude<SuggestionKind, DiscoveryKind>

export const isDiscoveryKind = (kind: SuggestionKind): kind is DiscoveryKind =>
  kind === 'add_record' || kind === 'file_record'

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

/** An `add_record` payload, decoded — or the validator's refusal, by field. */
export function addRecordOf(payload: Json): AddRecordPayload {
  const parsed = addRecordPayloadSchema.safeParse(payload)
  if (parsed.success)
    return { ...parsed.data, evidence: evidenceOf(parsed.data.evidence) }
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'add_record'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/** A `file_record` payload, decoded — or the validator's refusal, by field. */
export function fileRecordOf(payload: Json): FileRecordPayload {
  const parsed = fileRecordPayloadSchema.safeParse(payload)
  if (parsed.success)
    return { ...parsed.data, evidence: evidenceOf(parsed.data.evidence) }
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'file_record'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/** A task payload, decoded — or the validator's refusal, by field. */
export function taskOf(payload: Json): TaskPayload {
  const parsed = taskPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'task'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

export type ProposeInput = {
  entityId: string
  kind: RecordKind
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
  // A task likewise: a title, a due date or none, and the record it is about.
  if (input.kind === 'task') taskOf(input.payload)
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

// ---------- discovery cards (D72) ----------

export type DiscoveryProposeInput = {
  kind: DiscoveryKind
  /** `AddRecordPayload` or `FileRecordPayload`; the domain is normalized here. */
  payload: Json
  rationale?: string
  refs?: Array<string>
  runId?: string
  proposedBy: Actor
}

/**
 * What a discovery proposal came to.
 * - `proposed`: a new open card.
 * - `merged`: an open card for this (space, domain) already stood; this
 *   find's evidence, refs and watch were appended to it.
 * - `dismissed`: the domain is dismissed from the space; nothing was written.
 */
export type DiscoveryProposed =
  | { outcome: 'proposed'; suggestion: Suggestion }
  | { outcome: 'merged'; suggestion: Suggestion }
  | { outcome: 'dismissed' }

/** The payload decoded, its domain normalized, and the record it sits on. */
function discoveryRow(input: DiscoveryProposeInput): {
  spaceId: string
  domain: string
  entityId: string | null
  payload: Json
} {
  const card =
    input.kind === 'add_record'
      ? { ...addRecordOf(input.payload), entityId: null }
      : fileRecordOf(input.payload)
  const domain = normalizeDomain(card.domain)
  if (domain === null)
    throw invalid([
      { slug: 'domain', message: `domain: ${card.domain} names no company` },
    ])
  const payload: Json =
    input.kind === 'add_record'
      ? { ...addRecordOf(input.payload), domain }
      : { ...fileRecordOf(input.payload), domain }
  return { spaceId: card.spaceId, domain, entityId: card.entityId, payload }
}

/**
 * The first `cap` distinct elements of two jsonb arrays, old first, keyed by
 * `key` (an element's text when null): a merge never reorders what a card
 * already shows.
 */
const unionJsonb = (
  held: SQL,
  found: SQL,
  key: 'url' | null,
  cap: number,
): SQL => {
  const by = key === null ? sql.raw(`t.e #>> '{}'`) : sql.raw(`t.e ->> 'url'`)
  return sql`(select coalesce(jsonb_agg(k.e order by k.ord), '[]'::jsonb) from (
    select d.e, d.ord from (
      select distinct on (${by}) t.e, t.ord
      from jsonb_array_elements(coalesce(${held}, '[]'::jsonb) || coalesce(${found}, '[]'::jsonb)) with ordinality as t(e, ord)
      order by ${by}, t.ord
    ) d order by d.ord limit ${sql.raw(String(cap))}
  ) k)`
}

/**
 * Insert a discovery card, or merge into the open one for its (space,
 * domain) in the same statement: `ON CONFLICT` on
 * `suggestion_open_discovery_unique` appends the evidence (by URL), the
 * refs and the finding watches. The card's kind, name and record stay as
 * first proposed. (D77)
 */
async function upsertDiscovery(
  tx: Tx,
  input: DiscoveryProposeInput,
  row: { entityId: string | null; payload: Json },
): Promise<{ id: string; inserted: boolean }> {
  const proposedById =
    input.proposedBy.type === 'system' ? null : input.proposedBy.id
  const result = await tx.execute<{ id: string; inserted: boolean }>(sql`
    insert into suggestion as s
      (entity_id, kind, payload, rationale, refs, run_id, proposed_by_type, proposed_by_id)
    values (
      ${row.entityId}::uuid,
      ${input.kind}::suggestion_kind,
      ${JSON.stringify(row.payload)}::jsonb,
      ${input.rationale ?? null},
      array(select jsonb_array_elements_text(${JSON.stringify(input.refs ?? [])}::jsonb)),
      ${input.runId ?? null}::uuid,
      ${input.proposedBy.type}::actor_type,
      ${proposedById}
    )
    on conflict ((payload ->> 'spaceId'), (payload ->> 'domain'))
      where status = 'open' and suggestion_is_discovery(kind)
    do update set
      payload = s.payload || jsonb_build_object(
        'evidence', ${unionJsonb(sql.raw(`s.payload -> 'evidence'`), sql.raw(`excluded.payload -> 'evidence'`), 'url', MAX_EVIDENCE)},
        'watchIds', ${unionJsonb(sql.raw(`s.payload -> 'watchIds'`), sql.raw(`excluded.payload -> 'watchIds'`), null, MAX_WATCHES)}
      ),
      refs = array(
        select d.r from (
          select distinct on (u.r) u.r, u.ord
          from unnest(s.refs || excluded.refs) with ordinality as u(r, ord)
          order by u.r, u.ord
        ) d order by d.ord
      )
    returning s.id, (s.xmax = 0) as inserted
  `)
  const out = result.rows.at(0)
  if (!out) throw new Error('a discovery upsert returned no row')
  return out
}

/** Whether `domain` (normalized) is dismissed from the space's cards. */
export async function isDismissed(
  reader: Reader,
  spaceId: string,
  domain: string,
): Promise<boolean> {
  const hit = (
    await reader
      .select({ domain: spaceWatchDismissal.domain })
      .from(spaceWatchDismissal)
      .where(
        and(
          eq(spaceWatchDismissal.spaceId, spaceId),
          eq(spaceWatchDismissal.domain, domain),
        ),
      )
  ).at(0)
  return hit !== undefined
}

/**
 * Propose an `add_record` or `file_record` card for a space. (D72, D77)
 * - The dismissal read and the upsert share one transaction: a domain
 *   dismissed from the space writes nothing, ever.
 * - One open card per (space, domain): a later find merges into it
 *   (`upsertDiscovery`) rather than proposing again.
 * - `add_record` has no record, so its `entity_id` is null; a `file_record`
 *   row sits on the record it would file.
 */
export async function proposeDiscoveryWith(
  reader: Reader,
  input: DiscoveryProposeInput,
): Promise<DiscoveryProposed> {
  const { spaceId, domain, entityId, payload } = discoveryRow(input)
  return reader.transaction(async (tx): Promise<DiscoveryProposed> => {
    const target = (
      await tx
        .select({ id: space.entityId })
        .from(space)
        .where(eq(space.entityId, spaceId))
    ).at(0)
    if (!target)
      throw new EntityNotFound({
        entityId: spaceId,
        message: 'That space no longer exists',
      })
    if (entityId !== null) {
      const record = (
        await tx
          .select({ id: entity.id })
          .from(entity)
          .where(eq(entity.id, entityId))
      ).at(0)
      if (!record)
        throw new EntityNotFound({ entityId, message: 'Record not found' })
    }
    if (await isDismissed(tx, spaceId, domain)) return { outcome: 'dismissed' }
    const { id, inserted } = await upsertDiscovery(tx, input, {
      entityId,
      payload,
    })
    const row = (
      await tx.select().from(suggestion).where(eq(suggestion.id, id))
    ).at(0)
    if (!row) throw new Error('a discovery card vanished mid-transaction')
    return { outcome: inserted ? 'proposed' : 'merged', suggestion: row }
  })
}

export const proposeDiscoveryProgram = Effect.fn('proposeDiscoveryProgram')(
  function* (
    input: DiscoveryProposeInput,
  ): Effect.fn.Return<DiscoveryProposed, SuggestionFailure> {
    return yield* Effect.tryPromise({
      try: () => proposeDiscoveryWith(db, input),
      catch: asFailure,
    })
  },
)
