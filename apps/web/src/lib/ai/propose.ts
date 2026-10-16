import { Effect } from 'effect'
import type { z } from 'zod'
import { and, asc, eq, isNull, notInArray, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  activity,
  document,
  entity,
  link,
  space,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import { jsonRecord } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import { toPatch, validateProposal } from '@spaces/core/ai/schema'
import {
  EntityNotFound,
  setValuesInTx,
} from '@spaces/core/writes/attributes/values'
import type { SetValuesResult, Tx } from '@spaces/core/writes/attributes/values'
import {
  recordNameAlias,
  resolveEntity,
} from '@spaces/core/writes/entities/resolve'
import {
  readAddRecordPayload,
  readFileRecordPayload,
} from '@spaces/core/ai/discovery'
import type { ResolveResult } from '@spaces/core/writes/entities/resolve'
import { canonicalId } from '@spaces/core/writes/entities/sweep'
import {
  SuggestionInvalid,
  SuggestionNotFound,
  SuggestionNotOpen,
  UnsupportedSuggestionKind,
  addRecordOf,
  asFailure,
  documentKindOf,
  fileRecordOf,
  identityOf,
  invalid,
  ledgerEventOf,
  noteOf,
  patchAnchor,
  refileDocumentOf,
  registryFor,
  spaceTagOf,
  supersedesOf,
  taskOf,
} from '@spaces/core/writes/suggestions/propose'
import type {
  Suggestion,
  SuggestionFailure,
  SuggestionKind,
} from '@spaces/core/writes/suggestions/propose'
import type { CaptureObject } from '@spaces/core/writes/ai/capture-read'
import type { DomainEvent } from '@spaces/sdk'
import { dealLinked } from '@spaces/core/writes/events/dispatch'
import {
  SupersedesRefused,
  markNewerVersionInTx,
  supersedesMessage,
} from '@spaces/core/writes/links/supersedes'
import { writeSuggestedNoteInTx } from '#/lib/notes/from-suggestion'
import { insertSpaceTag, isLiveSpace } from '#/lib/spaces/tag'
import { liveSpaceSql } from '#/lib/spaces/live'
import { emitDomainEvent } from '#/lib/events/emit'
import { setPersonCompanyInTx } from '#/lib/people/companies'
import { insertTaskInTx } from '#/lib/tasks/create'
import { proposeNewerVersionProgram } from '@spaces/core/writes/documents/newer-version'
import { documentFilingRefusal } from '@spaces/core/documents/filing'
import type { DocumentFilingTarget } from '@spaces/core/documents/filing'
import { enqueueRestamp } from '#/lib/ai/enqueue-restamp'
import { fileDocumentInTx, unfileDocumentInTx } from '#/lib/documents/refile'
import { markInput, roundInput } from '#/lib/portfolio/inputs'
import {
  addMarkProgram,
  addRoundProgram,
  portfolioWriteMessage,
} from '#/lib/portfolio/write'

// The propose half moved into core (SPA-204): every name it exported is
// re-exported here unchanged, so the AI lanes, MCP, capture and their tests
// import it from where they always did.
export {
  SuggestionInvalid,
  SuggestionNotFound,
  SuggestionNotOpen,
  SuggestionWriteFailed,
  UnsupportedSuggestionKind,
  proposeProgram,
  registryFor,
} from '@spaces/core/writes/suggestions/propose'
export type {
  DiscoveryKind,
  DiscoveryProposeInput,
  DiscoveryProposed,
  ProposeInput,
  Reader,
  Suggestion,
  SuggestionFailure,
  SuggestionKind,
} from '@spaces/core/writes/suggestions/propose'

/**
 * The AI layer's one mutating verb (docs/spec-ai-substrate.md §3, §10).
 *
 * `proposeProgram` writes a `suggestion` row and nothing else — a model, an
 * agent or a prompt injection in a deck can at worst put noise in a queue.
 * It lives in `@spaces/core/writes/suggestions/propose` since SPA-204, where
 * the plugin ports reach it, and is re-exported above. `acceptProgram` is
 * the only way a suggestion becomes a value, and it goes through the one
 * write path (`setValuesInTx`) with the **accepter** as actor,
 * `source = 'suggestion'`, and the row's id and refs as the receipt on
 * every `attribute_event`. `rejectProgram` closes a row and writes nothing
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
 * Among the kinds: `attribute_patch` (a value, through the one write
 * path), `identity` (a person, through `resolveEntity`; a company record
 * joins the person's `companies`, and the person is written into the
 * reference field the claim came from), `task` (one task, through the task
 * writer), `supersedes` (one link, through the supersedes writer; D59) and
 * `ledger_event` (one `round` or `mark`, appended through the portfolio
 * writer; D12). The discovery cards (`add_record`, `file_record`) sit on a space, not a record: accept
 * resolves and files, reject dismisses the domain from the space. (D72)
 *
 * **A captured page is an anchor too (SPA-134).** A capture names somebody
 * we usually hold no record for, so its read is anchored on the captured
 * document's own entity (`@spaces/core/writes/ai/capture-read`). Two things differ
 * there, and nothing else: a patch on a document is held to the registry of
 * the object its run read the page against (`patchAnchor`), and lands on the
 * one record of that object the page is filed on; an identity on a document
 * files the page on the person it resolves (`tagged_in`) rather than adding
 * it to their companies — which is what then gives the patch its record.
 */

/** Only a person accepts or rejects: the decision is what `decided_by` names. */
export type Decider = { type: 'user'; id: string }

/** A row of a record kind, its record known present. */
type Anchored = Suggestion & { entityId: string }

/** The record a record kind's row is about; only `add_record` has none. */
function anchored(row: Suggestion): Anchored {
  const { entityId } = row
  if (entityId === null)
    throw new EntityNotFound({ entityId: row.id, message: 'Record not found' })
  return { ...row, entityId }
}

/** Read wider than `Decider` on purpose: the runtime half of that claim. */
const isPerson = (actor: { type: string }): boolean => actor.type === 'user'

const KIND_LABEL: Record<SuggestionKind, string> = {
  attribute_patch: 'field change',
  note: 'note',
  ledger_event: 'ledger event',
  identity: 'identity',
  document_kind: 'document type',
  space_tag: 'space tag',
  task: 'task',
  add_record: 'new company',
  file_record: 'filing',
  supersedes: 'newer version',
  refile_document: 're-file',
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
       * True when this accept added the company record to the person's
       * `companies` — or, for a captured page (SPA-134), filed the page on
       * them. False when it was already so, and for any other record.
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
  | {
      kind: 'task'
      suggestion: Suggestion
      /** The task the accept wrote. */
      taskId: string
    }
  | {
      kind: 'add_record'
      suggestion: Suggestion
      /** What `resolveEntity` did: created the company, or found it held. */
      resolved: ResolveResult
      /** The space it was filed in: the card's, or the hinted subspace. */
      spaceId: string
      /** False when the record was already filed there. */
      tagged: boolean
    }
  | {
      kind: 'file_record'
      suggestion: Suggestion
      entityId: string
      spaceId: string
      tagged: boolean
    }
  | {
      kind: 'supersedes'
      suggestion: Suggestion
      /** False when the link was already there: the accept only closes. */
      written: boolean
    }
  | {
      kind: 'refile_document'
      suggestion: Suggestion
      documentId: string
      fromEntityId: string
      toEntityId: string
    }
  | {
      kind: 'ledger_event'
      suggestion: Suggestion
      /** The table the accept appended to, and the row. */
      event: 'round' | 'mark'
      eventId: string
    }

/**
 * Accept an identity (SPA-105, spec §11): the person a document named walks
 * through `resolveEntity` — the one door every creator uses — and, when the
 * suggestion sits on a company, gains it in their `companies`. (D60)
 *
 * - An exact email or LinkedIn match **attaches**: no new entity, and the
 *   name the document used becomes a name alias of the person already held.
 * - No match **creates** the person, and `resolveEntity`'s inline trigram
 *   sweep files a `duplicate_candidate` for every near-miss name — the pair
 *   the /inbox pair card already draws. Fuzzy never merges.
 *
 * `resolveEntity` is Promise-shaped and writes on `db`, not on this
 * transaction, so the person it creates commits on its own connection
 * before the value writes and the flip below. The row lock this transaction
 * holds is what still serializes two accepts of one row: the second waits,
 * then reads `accepted`. If a write or the flip then fails, the person stays
 * and the suggestion stays open; a retry attaches by key or files the pair —
 * the one door's own doctrine, not a second person silently welded.
 *
 * Then the person is written into the field the claim was read off
 * (SPA-160; `fileIntoReference` below) — `founders` on a company, `people`
 * or `referred_by` on a deal — through the one write path, in this
 * transaction, so both values and the flip commit together.
 */
async function acceptIdentityInTx(
  tx: Tx,
  row: Anchored,
  actor: Decider,
  owed: Array<DomainEvent | null>,
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

  // The person is at the company the deck was read against. A deal or a
  // custom record is not somewhere a person works; the field below says
  // how they relate to it.
  const joined =
    record.kind === 'company'
      ? await setPersonCompanyInTx(tx, {
          personId: resolved.entityId,
          companyId: recordId,
          action: 'link',
          actor,
          source: 'suggestion',
          suggestionId: row.id,
          refs: row.refs,
        })
      : null
  // A row proposed before SPA-160 names no field: it accepts as the company
  // alone.
  const filed =
    claim.attribute === undefined
      ? null
      : await fileIntoReference(tx, {
          row,
          recordId,
          slug: claim.attribute,
          personId: resolved.entityId,
          actor,
          owed,
        })
  return { resolved, linked: joined !== null, filed }
}

/**
 * File a captured page on the person its identity resolved to: the
 * `tagged_in` edge a document is filed through, and the `document.refiled`
 * line `fileDocumentProgram` writes, with the suggestion as its receipt.
 * False when the page was already filed there.
 */
async function filePageOn(
  tx: Tx,
  row: Anchored,
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
 *   is skipped rather than refused: the person and their company still stand.
 *
 * The record's row is locked before its value is read, so two identities
 * accepted concurrently on one record append in turn rather than each
 * writing its own one-person list over the other's.
 */
async function fileIntoReference(
  tx: Tx,
  input: {
    row: Anchored
    recordId: string
    slug: string
    personId: string
    actor: Decider
    /** The `deal.linked` events the write owes after the commit. */
    owed: Array<DomainEvent | null>
  },
): Promise<string | null> {
  const { row, recordId, slug, personId, actor, owed } = input
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
  const { dealParties } = await setValuesInTx(tx, {
    entityId: recordId,
    patch: { [slug]: next },
    actor,
    source: 'suggestion',
    suggestionId: row.id,
    refs: row.refs,
  })
  for (const party of dealParties) owed.push(dealLinked(party, 'manual'))
  return slug
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
  row: Anchored,
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

// ---------- supersedes (D59) ----------

/**
 * Accept a newer version: `link(supersedes)` newer → older through
 * `markNewerVersionInTx`, the one supersedes writer, in this transaction —
 * the link and the closed suggestion commit together. A pair the writer
 * refuses (one side gone, the reverse already linked) refuses the accept
 * and the row stays open.
 */
async function acceptSupersedesInTx(
  tx: Tx,
  row: Anchored,
  actor: Decider,
): Promise<{ written: boolean }> {
  const pair = supersedesOf(row.payload)
  try {
    return await markNewerVersionInTx(
      tx,
      { newerId: pair.newerId, olderId: pair.olderId, actorId: actor.id },
      row.id,
    )
  } catch (cause) {
    if (cause instanceof SupersedesRefused)
      throw invalid([{ slug: 'supersedes', message: supersedesMessage(cause) }])
    throw cause
  }
}

// ---------- refile_document ----------

/** What a re-file owes once its transaction commits. */
type RefileAfter = { proposeNewer: boolean; lowered: Array<string> }

/**
 * Accept a re-file: the document's edge on `from` is removed and one on
 * `to` written, by the accepter, through the re-file writers, in this
 * transaction. A document no longer filed on `from` refuses — a person or
 * an earlier accept already moved it — and the row stays open.
 */
async function acceptRefileDocumentInTx(
  tx: Tx,
  row: Anchored,
  actor: Decider,
): Promise<{
  documentId: string
  fromEntityId: string
  toEntityId: string
  after: RefileAfter
}> {
  const move = refileDocumentOf(row.payload)
  const { documentId } = move
  const held = (
    await tx
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.entityId, documentId))
      .for('update')
  ).at(0)
  if (!held)
    throw new EntityNotFound({
      entityId: documentId,
      message: 'That document no longer exists',
    })
  const ends = await tx
    .select({
      id: entity.id,
      kind: entity.kind,
      mergedIntoId: entity.mergedIntoId,
    })
    .from(entity)
    .where(sql`${entity.id} in (${move.fromEntityId}, ${move.toEntityId})`)
  const end = (id: string) => ends.find((e) => e.id === id)
  const filing = (id: string, kind: string): DocumentFilingTarget => ({
    kind: kind === 'space' ? 'space' : 'record',
    entityId: id,
  })
  const to = end(move.toEntityId)
  if (!to || to.mergedIntoId !== null)
    throw new EntityNotFound({
      entityId: move.toEntityId,
      message: `${move.toName} no longer exists`,
    })
  const toTarget = filing(to.id, to.kind)
  const refusal = documentFilingRefusal(toTarget, to.kind)
  if (refusal !== null)
    throw invalid([{ slug: 'toEntityId', message: refusal }])
  const fromTarget = filing(
    move.fromEntityId,
    end(move.fromEntityId)?.kind ?? 'record',
  )
  const { unfiled, lowered } = await unfileDocumentInTx(tx, actor.id, {
    documentId,
    target: fromTarget,
  })
  if (!unfiled)
    throw invalid([
      {
        slug: 'fromEntityId',
        message: `${move.documentName} is no longer filed on ${move.fromName}`,
      },
    ])
  const { filed } = await fileDocumentInTx(tx, actor.id, {
    documentId,
    target: toTarget,
  })
  return {
    documentId,
    fromEntityId: move.fromEntityId,
    toEntityId: move.toEntityId,
    after: { proposeNewer: filed && toTarget.kind === 'record', lowered },
  }
}

// ---------- ledger_event (D12) ----------

/**
 * Accept a ledger event: one `round` or `mark` appended through the
 * portfolio writer, by the accepter, in this transaction, the suggestion
 * named on its activity row. The numbers are held to the server fns' own
 * validators first; a refusal carries the validator's message and the row
 * stays open. Nothing is updated or deleted.
 */
async function acceptLedgerEventInTx(
  tx: Tx,
  row: Anchored,
  actor: Decider,
): Promise<{ event: 'round' | 'mark'; eventId: string }> {
  const ledger = ledgerEventOf(row.payload)
  const by = { suggestionId: row.id, actorId: actor.id }
  const append =
    ledger.event === 'round'
      ? addRoundProgram(
          {
            ...portfolioChecked(roundInput, {
              ...ledger.proposed,
              companyId: ledger.companyId,
            }),
            ...by,
          },
          tx,
        )
      : addMarkProgram(
          { ...portfolioChecked(markInput, ledger.proposed), ...by },
          tx,
        )
  const written = await Effect.runPromise(Effect.result(append))
  if (written._tag === 'Failure')
    throw invalid([
      { slug: ledger.event, message: portfolioWriteMessage(written.failure) },
    ])
  return { event: ledger.event, eventId: written.success.id }
}

/** A portfolio input through its server fn's validator, or its refusal. */
function portfolioChecked<T>(validator: z.ZodType<T>, input: unknown): T {
  const checked = validator.safeParse(input)
  if (checked.success) return checked.data
  throw invalid(
    checked.error.issues.map((i) => {
      const slug = i.path.map(String).join('.') || 'ledger_event'
      return { slug, message: `${slug}: ${i.message}` }
    }),
  )
}

// ---------- note (SPA-66) ----------

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
  row: Anchored,
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
  row: Anchored,
  actor: Decider,
): Promise<{ spaceId: string; tagged: boolean; emit: DomainEvent | null }> {
  const { spaceId, confidence } = spaceTagOf(row.payload)
  if (!(await isLiveSpace(tx, spaceId)))
    throw new EntityNotFound({
      entityId: spaceId,
      message: 'That space no longer exists',
    })
  const recordId = await canonicalId(row.entityId, tx)
  const { tagged, emit } = await insertSpaceTag(tx, {
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
  return { spaceId, tagged, emit }
}

// ---------- task ----------

/**
 * Accept a task: one `task` row through the task writer, created by and
 * assigned to the accepter, linked to the payload's record — its survivor
 * when it was merged since. A record gone since refuses, and the row stays
 * open.
 */
async function acceptTaskInTx(
  tx: Tx,
  row: Anchored,
  actor: Decider,
): Promise<{ taskId: string }> {
  const payload = taskOf(row.payload)
  const recordId = await canonicalId(payload.entity_id, tx)
  const live = (
    await tx
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.id, recordId))
  ).at(0)
  if (!live)
    throw new EntityNotFound({
      entityId: payload.entity_id,
      message: 'Record not found',
    })
  const { id } = await insertTaskInTx(tx, {
    content: payload.title,
    dueDate: payload.due,
    assigneeId: actor.id,
    createdBy: actor.id,
    entityIds: [recordId],
  })
  return { taskId: id }
}

// ---------- discovery cards (D72) ----------

/**
 * The live subspace under `spaceId` a hint names, by name or slug, nearest
 * first; null when none does. A hint is advice, never a refusal.
 */
async function hintedSubspace(
  tx: Tx,
  spaceId: string,
  hint: string | null,
): Promise<string | null> {
  if (hint === null) return null
  const root = (
    await tx
      .select({ path: space.path })
      .from(space)
      .where(eq(space.entityId, spaceId))
  ).at(0)
  if (!root) return null
  const match = (
    await tx
      .select({ id: space.entityId })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(
          sql`${space.path} <@ ${root.path}::ltree`,
          sql`${space.entityId} <> ${spaceId}`,
          isNull(entity.mergedIntoId),
          liveSpaceSql,
          or(
            sql`lower(${entity.canonicalName}) = lower(${hint})`,
            eq(space.slug, hint),
          ),
        ),
      )
      .orderBy(sql`nlevel(${space.path})`)
      .limit(1)
  ).at(0)
  return match?.id ?? null
}

/** File a record in a space by the accepter, with the one `space.tagged` line. */
async function fileDiscovered(
  tx: Tx,
  row: Suggestion,
  recordId: string,
  spaceId: string,
  actor: Decider,
): Promise<{ tagged: boolean; emit: DomainEvent | null }> {
  const { tagged, emit } = await insertSpaceTag(tx, {
    entityId: recordId,
    spaceId,
    source: 'ai',
    confidence: null,
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
  return { tagged, emit }
}

/**
 * Accept "add X?": the company walks through `resolveEntity` — a domain
 * already held attaches, else it is born — and is filed in the card's space,
 * or the hinted subspace when one matches. The birth's `entity.created` is
 * owed after the commit, so an auto-enrich scoped to the space sees the
 * filing. (D72)
 * - `resolveEntity` commits on its own connection, as the identity accept's
 *   does: a failure after it leaves the company and the card open, and a
 *   retry attaches by domain.
 */
async function acceptAddRecordInTx(
  tx: Tx,
  row: Suggestion,
  actor: Decider,
  owed: Array<DomainEvent | null>,
): Promise<{ resolved: ResolveResult; spaceId: string; tagged: boolean }> {
  const card = addRecordOf(row.payload)
  if (!(await isLiveSpace(tx, card.spaceId)))
    throw new EntityNotFound({
      entityId: card.spaceId,
      message: 'That space no longer exists',
    })
  const spaceId =
    (await hintedSubspace(tx, card.spaceId, card.subspaceHint)) ?? card.spaceId
  const resolved = await resolveEntity({
    kind: 'company',
    name: card.name,
    keys: { domain: card.domain },
    // A person decided this company exists; the card is the provenance.
    source: { class: 'manual' },
    createdBy: actor.id,
  })
  for (const alias of card.aliases)
    await recordNameAlias(resolved.entityId, alias, { class: 'manual' }, tx)
  const { tagged, emit } = await fileDiscovered(
    tx,
    row,
    resolved.entityId,
    spaceId,
    actor,
  )
  owed.push(resolved.emit, emit)
  return { resolved, spaceId, tagged }
}

/** Accept "also file X here?": the held record, followed through a merge. */
async function acceptFileRecordInTx(
  tx: Tx,
  row: Suggestion,
  actor: Decider,
  owed: Array<DomainEvent | null>,
): Promise<{ entityId: string; spaceId: string; tagged: boolean }> {
  const card = fileRecordOf(row.payload)
  if (!(await isLiveSpace(tx, card.spaceId)))
    throw new EntityNotFound({
      entityId: card.spaceId,
      message: 'That space no longer exists',
    })
  const recordId = await canonicalId(card.entityId, tx)
  const live = (
    await tx
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.id, recordId))
  ).at(0)
  if (!live)
    throw new EntityNotFound({
      entityId: card.entityId,
      message: 'Record not found',
    })
  const { tagged, emit } = await fileDiscovered(
    tx,
    row,
    recordId,
    card.spaceId,
    actor,
  )
  owed.push(emit)
  return { entityId: recordId, spaceId: card.spaceId, tagged }
}

/**
 * The (space, domain) a discovery card's reject dismisses, or null for a
 * row that is not one.
 */
function dismissalOf(
  row: Suggestion,
): { spaceId: string; domain: string } | null {
  const card =
    row.kind === 'add_record'
      ? readAddRecordPayload(row.payload)
      : row.kind === 'file_record'
        ? readFileRecordPayload(row.payload)
        : null
  return card === null ? null : { spaceId: card.spaceId, domain: card.domain }
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
  // The events an accept owes — a space tag's `filed`, a deal party's
  // `deal.linked` — dispatched once the commit lands.
  const owed: Array<DomainEvent | null> = []
  // A re-file's follow-ups, also after the commit.
  const refiled: Array<{ documentId: string; after: RefileAfter }> = []
  const accepted = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const locked = await lockOpen(tx, id)
        if (locked.kind === 'add_record' || locked.kind === 'file_record') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message: 'fields: a discovery card is accepted whole',
              },
            ])
          if (locked.kind === 'add_record') {
            const { resolved, spaceId, tagged } = await acceptAddRecordInTx(
              tx,
              locked,
              actor,
              owed,
            )
            const decided = await close(tx, id, 'accepted', actor)
            return {
              kind: 'add_record',
              suggestion: decided,
              resolved,
              spaceId,
              tagged,
            } satisfies Accepted
          }
          const { entityId, spaceId, tagged } = await acceptFileRecordInTx(
            tx,
            locked,
            actor,
            owed,
          )
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'file_record',
            suggestion: decided,
            entityId,
            spaceId,
            tagged,
          } satisfies Accepted
        }
        const row = anchored(locked)
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
            owed,
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
          const { spaceId, tagged, emit } = await acceptSpaceTagInTx(
            tx,
            row,
            actor,
          )
          owed.push(emit)
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'space_tag',
            suggestion: decided,
            spaceId,
            tagged,
          } satisfies Accepted
        }
        if (row.kind === 'task') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message: 'fields: a task is accepted whole, not by field',
              },
            ])
          const { taskId } = await acceptTaskInTx(tx, row, actor)
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'task',
            suggestion: decided,
            taskId,
          } satisfies Accepted
        }
        if (row.kind === 'supersedes') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message:
                  'fields: a newer version is accepted whole, not by field',
              },
            ])
          const { written } = await acceptSupersedesInTx(tx, row, actor)
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'supersedes',
            suggestion: decided,
            written,
          } satisfies Accepted
        }
        if (row.kind === 'refile_document') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message: 'fields: a re-file is accepted whole, not by field',
              },
            ])
          const { after, ...moved } = await acceptRefileDocumentInTx(
            tx,
            row,
            actor,
          )
          refiled.push({ documentId: moved.documentId, after })
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'refile_document',
            suggestion: decided,
            ...moved,
          } satisfies Accepted
        }
        if (row.kind === 'ledger_event') {
          if (fields !== undefined)
            throw invalid([
              {
                slug: 'fields',
                message:
                  'fields: a ledger event is accepted whole, not by field',
              },
            ])
          const { event, eventId } = await acceptLedgerEventInTx(tx, row, actor)
          const decided = await close(tx, id, 'accepted', actor)
          return {
            kind: 'ledger_event',
            suggestion: decided,
            event,
            eventId,
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
  for (const event of owed) yield* Effect.promise(() => emitDomainEvent(event))
  for (const { documentId, after } of refiled) {
    // Filed on a record after arrival: the same suggestion intake makes. (D59)
    if (after.proposeNewer) yield* proposeNewerVersionProgram(documentId)
    if (after.lowered.length > 0)
      yield* Effect.promise(() => enqueueRestamp(after.lowered))
  }
  return accepted
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
 * "Accept all on this record": every open suggestion on it but a
 * `supersedes` or a `ledger_event`, oldest first
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
            // Accepted one at a time, never in bulk: a wrong supersession
            // hides true facts from the AI (D59), and a ledger event is an
            // append a person makes alone — a round cannot be voided (D12).
            notInArray(suggestion.kind, ['supersedes', 'ledger_event']),
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

/**
 * Reject a suggestion. A discovery card's reject is a dismissal too: the
 * (space, domain) row, written in the same transaction, refuses every later
 * card for the domain in that space. (D72)
 */
export const rejectProgram = Effect.fn('rejectProgram')(function* (
  id: string,
  actor: Decider,
): Effect.fn.Return<Suggestion, SuggestionFailure> {
  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const row = await close(tx, id, 'rejected', actor)
        const dismissal = dismissalOf(row)
        if (dismissal !== null)
          await tx
            .insert(spaceWatchDismissal)
            .values({ ...dismissal, dismissedBy: actor.id })
            .onConflictDoNothing()
        return row
      }),
    catch: asFailure,
  })
})
