import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { activity, document, entity, link, suggestion } from '@spaces/db/schema'
import type { suggestionKind } from '@spaces/db/schema'
import { jsonRecord } from '#/lib/json'
import type { Json } from '#/lib/json'
import { proposalRefs, toPatch, validateProposal } from '@spaces/core/ai/schema'
import type { ProposalIssue } from '@spaces/core/ai/schema'
import { identityPayloadSchema } from '@spaces/core/ai/identity'
import { documentKindPayloadSchema } from '@spaces/core/ai/document-kind'
import { spaceTagPayloadSchema } from '@spaces/core/ai/space-tag'
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
import { resolveEntity } from '#/lib/entities/resolve'
import type { ResolveResult } from '#/lib/entities/resolve'
import { canonicalId } from '#/lib/entities/sweep'
import { notePayloadSchema } from '@spaces/core/ai/note'
import { writeSuggestedNoteInTx } from '#/lib/notes/from-suggestion'
import { insertSpaceTag, isLiveSpace } from '#/lib/spaces/tag'
import { captureObjectOfRun } from './capture-read'
import type { CaptureObject } from './capture-read'

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
 *
 * Two kinds accept today: `attribute_patch` (a value, through the one write
 * path) and `identity` (SPA-105: a person, through `resolveEntity`, plus a
 * `contact_at` link to the record and — SPA-160 — the person written into
 * the reference field the claim came from). Every other kind is refused by
 * name.
 *
 * **A captured page is an anchor too (SPA-134).** A capture names somebody
 * we usually hold no record for, so its read is anchored on the captured
 * document's own entity (`lib/ai/capture-read.ts`). Two things differ
 * there, and nothing else: a patch on a document is held to the registry of
 * the object its run read the page against (`patchAnchor`), and lands on the
 * one record of that object the page is filed on; an identity on a document
 * files the page on the person it resolves (`tagged_in`) rather than linking
 * them `contact_at` it — which is what then gives the patch its record.
 */

export type SuggestionKind = (typeof suggestionKind.enumValues)[number]

/** Only a person accepts or rejects: the decision is what `decided_by` names. */
export type Decider = { type: 'user'; id: string }

/** Read wider than `Decider` on purpose: the runtime half of that claim. */
const isPerson = (actor: { type: string }): boolean => actor.type === 'user'

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

const KIND_LABEL: Record<SuggestionKind, string> = {
  attribute_patch: 'field change',
  note: 'note',
  ledger_event: 'ledger event',
  identity: 'identity',
  document_kind: 'document type',
  space_tag: 'space tag',
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

/**
 * What a patch on this entity is held to, and — for a captured page — the
 * object it was read against (SPA-134). A record is its own anchor and its
 * own registry. A document holds a patch only when a capture read wrote it:
 * its run names the object, and that object's live registry is the one the
 * model was handed, so propose and accept validate against what was read.
 */
async function patchAnchor(
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

/**
 * The record a captured page's patch applies to: the one live record of the
 * object it was read against that the page is filed on. Accepting the
 * page's identity is what files it on the person (`acceptIdentityInTx`);
 * a company page applies once it is filed on a company.
 */
async function pageTarget(
  tx: Tx,
  documentId: string,
  page: CaptureObject,
): Promise<string> {
  const ofObject =
    page.kind === null
      ? eq(entity.objectId, page.id)
      : or(
          eq(entity.objectId, page.id),
          and(isNull(entity.objectId), eq(entity.kind, page.kind)),
        )
  const filed = await tx
    .select({ id: entity.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(
        eq(link.fromEntityId, documentId),
        eq(link.relation, 'tagged_in'),
        isNull(entity.mergedIntoId),
        ofObject,
      ),
    )
  const only = filed.at(0)
  const what = page.singular.toLowerCase()
  if (only === undefined)
    throw invalid([
      {
        slug: 'record',
        message:
          page.kind === 'person'
            ? 'Accept the identity first: these fields apply to the person it matches or creates'
            : `File the page on a ${what} first: these fields apply to the ${what} it is filed on`,
      },
    ])
  if (filed.length > 1)
    throw invalid([
      {
        slug: 'record',
        message: `The page is filed on more than one ${what}: these fields apply to one`,
      },
    ])
  return only.id
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
        const { registry } = await patchAnchor(
          db,
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

export type Accepted =
  | { kind: 'attribute_patch'; suggestion: Suggestion; write: SetValuesResult }
  | {
      kind: 'identity'
      suggestion: Suggestion
      /** What `resolveEntity` did: attached to a known person, or created one. */
      resolved: ResolveResult
      /**
       * False when the person was already `contact_at` the record — or, for
       * a captured page (SPA-134), when the page was already filed on them.
       */
      linked: boolean
      /**
       * The person-reference attribute that holds the person after this
       * accept (SPA-160) — written now or already held. Null when the
       * payload names no field (a row proposed before SPA-160), when the
       * field no longer takes a person, or when it is single-valued and
       * already holds somebody else.
       */
      filed: string | null
    }
  | {
      kind: 'document_kind'
      suggestion: Suggestion
      /** The kind the document had, and the kind it has now. */
      from: string
      to: string
    }
  | {
      kind: 'note'
      suggestion: Suggestion
      /** The note the accept wrote (SPA-66). */
      noteId: string
    }
  | {
      kind: 'space_tag'
      suggestion: Suggestion
      spaceId: string
      /** False when the record was already in the space: its row stands. */
      tagged: boolean
    }

/** An identity payload, decoded — or the validator's refusal, by field. */
function identityOf(payload: Json) {
  const parsed = identityPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'identity'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/**
 * Accept an identity (SPA-105, spec §11): the person a document named walks
 * through `resolveEntity` — the one door every creator uses — and is linked
 * `contact_at` the record the suggestion sits on.
 *
 * - An exact email or LinkedIn match **attaches**: no new entity, and the
 *   name the document used becomes a name alias of the person already held.
 * - No match **creates** the person, and `resolveEntity`'s inline trigram
 *   sweep files a `duplicate_candidate` for every near-miss name — the pair
 *   the /inbox pair card already draws. Fuzzy never merges.
 *
 * `resolveEntity` is Promise-shaped and writes on `db`, not on this
 * transaction, so the person it creates commits on its own connection
 * before the link and the flip below. The row lock this transaction holds
 * is what still serializes two accepts of one row: the second waits, then
 * reads `accepted`. If the link or the flip then fails, the person stays and
 * the suggestion stays open; a retry attaches by key or files the pair —
 * the one door's own doctrine, not a second person silently welded.
 *
 * Then the person is written into the field the claim was read off
 * (SPA-160; `fileIntoReference` below) — `founders` on a company, `people`
 * or `referred_by` on a deal — through the one write path, in this
 * transaction, so the link, the value and the flip commit together.
 */
async function acceptIdentityInTx(
  tx: Tx,
  row: Suggestion,
  actor: Decider,
): Promise<{
  resolved: ResolveResult
  linked: boolean
  filed: string | null
}> {
  const claim = identityOf(row.payload)
  const recordId = await canonicalId(row.entityId, tx)
  const record = (
    await tx
      .select({ kind: entity.kind })
      .from(entity)
      .where(eq(entity.id, recordId))
  ).at(0)
  if (!record)
    throw new EntityNotFound({
      entityId: row.entityId,
      message: 'Record not found',
    })

  const resolved = await resolveEntity({
    kind: 'person',
    name: claim.name,
    keys: {
      ...(claim.email === undefined ? {} : { email: claim.email }),
      ...(claim.linkedin === undefined ? {} : { linkedin: claim.linkedin }),
    },
    // `entity_source` has no value meaning "extracted from a document", and
    // adding one would collide with clean's source_class collapse. `import`
    // it is until clean's source_class/source_ref work gives this birth its
    // real provenance; until then the provenance rides the suggestion row —
    // its refs cite the deck, and `decided_by` names who accepted it.
    source: { class: 'import' },
    // The accepter, never a machine: a person decided this person exists.
    createdBy: actor.id,
    // The role the document gave them, as a birth value only: on an attach
    // the person already held keeps the title they have.
    ...(claim.role === undefined ? {} : { values: { job_title: claim.role } }),
  })
  if (resolved.entityId === recordId)
    throw invalid([
      { slug: 'identity', message: 'A person cannot be a contact at itself' },
    ])

  // SPA-134: a captured page's identity. The page is not somewhere a person
  // is a contact at; it is the source they were read from, so it is filed
  // on them — which is also what its patch then applies through.
  if (record.kind === 'document')
    return {
      resolved,
      linked: await filePageOn(tx, row, resolved.entityId, actor),
      filed: null,
    }

  const inserted = await tx
    .insert(link)
    .values({
      fromEntityId: resolved.entityId,
      toEntityId: recordId,
      relation: 'contact_at',
      source: 'extracted',
      createdBy: actor.id,
    })
    .onConflictDoNothing()
    .returning({ id: link.id })
  // A row proposed before SPA-160 names no field: it accepts as the link
  // alone, which is all an identity used to write.
  const filed =
    claim.attribute === undefined
      ? null
      : await fileIntoReference(tx, {
          row,
          recordId,
          slug: claim.attribute,
          personId: resolved.entityId,
          actor,
        })
  return { resolved, linked: inserted.length > 0, filed }
}

/**
 * File a captured page on the person its identity resolved to: the
 * `tagged_in` edge a document is filed through, and the `document.refiled`
 * line `fileDocumentProgram` writes, with the suggestion as its receipt.
 * False when the page was already filed there.
 */
async function filePageOn(
  tx: Tx,
  row: Suggestion,
  personId: string,
  actor: Decider,
): Promise<boolean> {
  const added = await tx
    .insert(link)
    .values({
      fromEntityId: row.entityId,
      toEntityId: personId,
      relation: 'tagged_in',
      source: 'extracted',
      createdBy: actor.id,
    })
    .onConflictDoNothing()
    .returning({ id: link.id })
  if (added.length === 0) return false
  await tx.insert(activity).values({
    actorId: actor.id,
    verb: 'document.refiled',
    subjectEntityId: personId,
    objectEntityId: row.entityId,
    meta: { action: 'filed', target: 'record', suggestionId: row.id },
  })
  return true
}

/**
 * Add the accepted person to a person-reference attribute on the record,
 * through `setValuesInTx` — validated, logged as an `attribute_event` with
 * the suggestion as its receipt, and linked `references` like any other
 * reference write. Returns the slug when the record holds the person there
 * afterwards, else null.
 *
 * - **multi** (`founders`, `people`): appended. A person already held is not
 *   added twice — two suggestions naming one person, accepted one after the
 *   other, leave one entry — and every other entry stays as it was.
 * - **single** (`referred_by`): set only when empty. A slot already holding
 *   somebody else is the operator's to change; an accept never overwrites it.
 * - A field retired, retyped or no longer aimed at people since the proposal
 *   is skipped rather than refused: the person and the link still stand.
 *
 * The record's row is locked before its value is read, so two identities
 * accepted concurrently on one record append in turn rather than each
 * writing its own one-person list over the other's.
 */
async function fileIntoReference(
  tx: Tx,
  input: {
    row: Suggestion
    recordId: string
    slug: string
    personId: string
    actor: Decider
  },
): Promise<string | null> {
  const { row, recordId, slug, personId, actor } = input
  const def = (await registryFor(tx, recordId)).find((d) => d.slug === slug)
  if (
    def === undefined ||
    def.type !== 'record_reference' ||
    def.options.targetKind !== 'person'
  )
    return null
  const held = (
    await tx
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, recordId))
      .for('update')
  ).at(0)?.values[slug]

  let next: string | Array<string>
  if (def.options.multi) {
    const ids = Array.isArray(held) ? held.map(String) : []
    if (ids.includes(personId)) return slug
    next = [...ids, personId]
  } else {
    if (held === personId) return slug
    if (held !== undefined && held !== null) return null
    next = personId
  }
  await setValuesInTx(tx, {
    entityId: recordId,
    patch: { [slug]: next },
    actor,
    source: 'suggestion',
    suggestionId: row.id,
    refs: row.refs,
  })
  return slug
}

/** A document-kind payload, decoded — or the validator's refusal. */
function documentKindOf(payload: Json) {
  const parsed = documentKindPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'document_kind'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/**
 * Accept a classification (SPA-62, spec §11's first row): the document's
 * `kind` is set to the proposed one and one `document.reclassified`
 * activity row is written on the document's own stream, attributed to the
 * accepter, `from` and `to` in its meta — as `setDocumentKindProgram`'s
 * `document.kind_changed` does for a hand edit, with the suggestion's id as
 * the receipt. The document row is locked first, so the `from` is the kind
 * this write replaced.
 *
 * Nothing is enqueued. Accepting `deck` is what makes Read deck appear on
 * the Files tab; a person presses it (spec §4, manual and pull-based).
 */
async function acceptDocumentKindInTx(
  tx: Tx,
  row: Suggestion,
  actor: Decider,
): Promise<{ from: string; to: string }> {
  const { kind } = documentKindOf(row.payload)
  const held = (
    await tx
      .select({ kind: document.kind })
      .from(document)
      .where(eq(document.entityId, row.entityId))
      .for('update')
  ).at(0)
  if (!held)
    throw new EntityNotFound({
      entityId: row.entityId,
      message: 'Document not found',
    })
  await tx
    .update(document)
    .set({ kind })
    .where(eq(document.entityId, row.entityId))
  await tx.insert(activity).values({
    actorId: actor.id,
    verb: 'document.reclassified',
    subjectEntityId: row.entityId,
    meta: { from: held.kind, to: kind, suggestionId: row.id },
  })
  return { from: held.kind, to: kind }
}

// ---------- note (SPA-66) ----------

/** A note payload, decoded — or the validator's refusal, by field. */
function noteOf(payload: Json) {
  const parsed = notePayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'note'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/**
 * Accept a note (SPA-66, spec §11 "Summarize"): the drafted body becomes a
 * real note — `bodyJson` and `bodyMd` both — with the accepter as author,
 * filed `tagged_in` the record the suggestion sits on and `derived_from`
 * the source it was drafted from (`lib/notes/from-suggestion.ts`), in this
 * transaction. Both ends are followed through a merge; a source deleted
 * since the proposal refuses the accept rather than writing a note that
 * claims a provenance it no longer has.
 */
async function acceptNoteInTx(
  tx: Tx,
  row: Suggestion,
  actor: Decider,
): Promise<{ noteId: string }> {
  const payload = noteOf(row.payload)
  const recordId = await canonicalId(row.entityId, tx)
  const sourceId = await canonicalId(payload.sourceId, tx)
  const found = await tx
    .select({ id: entity.id })
    .from(entity)
    .where(sql`${entity.id} in (${recordId}, ${sourceId})`)
  const has = (id: string) => found.some((f) => f.id === id)
  if (!has(recordId))
    throw new EntityNotFound({
      entityId: row.entityId,
      message: 'Record not found',
    })
  if (!has(sourceId))
    throw invalid([
      {
        slug: 'sourceId',
        message: 'sourceId: what this note was drafted from no longer exists',
      },
    ])
  return writeSuggestedNoteInTx(tx, {
    payload,
    recordId,
    sourceId,
    actorId: actor.id,
  })
}

// ---------- space tag (SPA-103) ----------

/** A space-tag payload, decoded — or the validator's refusal. */
function spaceTagOf(payload: Json) {
  const parsed = spaceTagPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  throw invalid(
    parsed.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'space_tag'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

/**
 * Accept a space tag (SPA-103): the record is tagged into the proposed
 * space through `insertSpaceTag` — the one `entity_space` insert, the one
 * `tagIntoSpace` uses — with `source: 'ai'`, the model's confidence and the
 * **accepter** as `created_by`. A model proposes; a person tags.
 *
 * A record merged since the proposal is tagged on its survivor, as an
 * identity accept links its survivor. A space merged or gone since is
 * refused, and the row stays open. A record already in the space (tagged by
 * hand between the proposal and now) keeps the row it has; the suggestion
 * still closes accepted, and no second `space.tagged` is written.
 */
async function acceptSpaceTagInTx(
  tx: Tx,
  row: Suggestion,
  actor: Decider,
): Promise<{ spaceId: string; tagged: boolean }> {
  const { spaceId, confidence } = spaceTagOf(row.payload)
  if (!(await isLiveSpace(tx, spaceId)))
    throw new EntityNotFound({
      entityId: spaceId,
      message: 'That space no longer exists',
    })
  const recordId = await canonicalId(row.entityId, tx)
  const tagged = await insertSpaceTag(tx, {
    entityId: recordId,
    spaceId,
    source: 'ai',
    confidence: confidence ?? null,
    createdBy: actor.id,
  })
  if (tagged)
    await tx.insert(activity).values({
      actorId: actor.id,
      verb: 'space.tagged',
      subjectEntityId: recordId,
      objectEntityId: spaceId,
      meta: { suggestionId: row.id, source: 'ai' },
    })
  return { spaceId, tagged }
}

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
 *
 * An `identity` accepts whole: it has no fields, so a `fields` argument is
 * refused as invalid rather than read as "all of it".
 */
export const acceptProgram = Effect.fn('acceptProgram')(function* (
  id: string,
  actor: Decider,
  fields?: ReadonlyArray<string>,
): Effect.fn.Return<Accepted, SuggestionFailure> {
  // SPA-31, spec §6: an agent is a client of the four contracts and gets no
  // fifth. `Decider` already admits only a person; this says it again at
  // runtime for a caller that reached here past the type — an integration
  // (an MCP token) proposes, it never accepts.
  if (!isPerson(actor))
    return yield* invalid([
      {
        slug: 'decided_by',
        message: 'decided_by: only a person accepts a suggestion',
      },
    ])
  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const row = await lockOpen(tx, id)
        if (row.kind === 'identity') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message: 'fields: an identity is accepted whole, not by field',
              },
            ])
          const { resolved, linked, filed } = await acceptIdentityInTx(
            tx,
            row,
            actor,
          )
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'identity',
            suggestion: decided,
            resolved,
            linked,
            filed,
          } satisfies Accepted
        }
        if (row.kind === 'document_kind') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message:
                  'fields: a document kind is accepted whole, not by field',
              },
            ])
          const { from, to } = await acceptDocumentKindInTx(tx, row, actor)
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'document_kind',
            suggestion: decided,
            from,
            to,
          } satisfies Accepted
        }
        if (row.kind === 'note') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message: 'fields: a note is accepted whole, not by field',
              },
            ])
          const { noteId } = await acceptNoteInTx(tx, row, actor)
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'note',
            suggestion: decided,
            noteId,
          } satisfies Accepted
        }
        if (row.kind === 'space_tag') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message: 'fields: a space tag is accepted whole, not by field',
              },
            ])
          const { spaceId, tagged } = await acceptSpaceTagInTx(tx, row, actor)
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'space_tag',
            suggestion: decided,
            spaceId,
            tagged,
          } satisfies Accepted
        }
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
        const { registry, page } = await patchAnchor(
          tx,
          row.entityId,
          row.runId,
        )
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
          // A captured page's patch lands on the record the page is filed
          // on, never on the document (SPA-134).
          entityId:
            page === null
              ? row.entityId
              : await pageTarget(tx, row.entityId, page),
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
        return {
          kind: 'attribute_patch',
          suggestion: decided,
          write,
        } satisfies Accepted
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
 * land. An identity is one item, accepted whole; a kind with no accept path
 * is one item, refused by name.
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
 *
 * `runId` narrows it to one run's suggestions — a column run's "Accept all"
 * in /inbox (SPA-122), which must not also accept the same attribute
 * proposed elsewhere by another run. A registry proposal (an empty patch
 * naming a wanted option) never matches: it proposes no value for the slug,
 * and accepting it would add nothing.
 */
export const acceptColumnProgram = Effect.fn('acceptColumnProgram')(
  function* (input: {
    attributeSlug: string
    actorId: string
    runId?: string
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
            input.runId === undefined
              ? undefined
              : eq(suggestion.runId, input.runId),
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
