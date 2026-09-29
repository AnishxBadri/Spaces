import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { chunk, document, entity, link, suggestion } from '@spaces/db/schema'
import {
  proposalRefs,
  schemaFor,
  toPatch,
  validateProposal,
} from '@spaces/core/ai/schema'
import type {
  IdentityClaim,
  Proposal,
  SchemaAttribute,
} from '@spaces/core/ai/schema'
import { identityPayloadOf } from '@spaces/core/ai/identity'
import { QUEUES } from '@spaces/core/queue/names'
import { getRegistryByObjectId } from '@spaces/core/writes/attributes/values'
import { recordContextProgram } from '#/lib/context/record'
import { ref } from '@spaces/core/context/ref'
import type { ContextItem } from '@spaces/core/context/types'
import { jsonValue } from '@spaces/core/json'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { storage } from '@spaces/core/writes/storage'
import { captureObjectById, captureReadTask } from './capture-read'
import type { CaptureObject } from './capture-read'
import { completeMessage } from './complete'
import type { CompleteFailure } from './complete'
import { cachedExtractProgram } from './extraction-cache'
import { proposeProgram, registryFor, suggestionMessage } from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
import { isLaneRoutedProgram } from './route'
import { callStep, suggestionOutputRef, withRun } from './run'
import type { RunScope, RunStepInput } from './run'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * The deck reader (SPA-90; docs/spec-ai-substrate.md §11, §14 step 2). The
 * first model call with a purpose: a `kind: deck` document whose text is
 * extracted becomes one `attribute_patch` suggestion on every record it is
 * filed against — never a value, a row in the inbox.
 *
 * Per filed record, the same path with a different registry:
 *
 *   1. context — the deck's own text first (`doc:<id>#n` per chunk where
 *      `chunk` rows of `source_kind: document` exist, else the extracted text whole as
 *      `doc:<id>#0`), then `recordContextProgram` on the record, which brings
 *      the space memos, the mandate and the glossary for free;
 *   2. `sensitivityFor(record)` — live, never cached — spread into the call;
 *   3. `cachedExtractProgram` (`./extraction-cache.ts`, SPA-74) — the
 *      extraction cache keyed on (blob, compiled schema, routed model), which
 *      answers a re-read or a second document over the same bytes from disk
 *      and otherwise calls `completeProgram('extract', items,
 *      schemaFor(registry), …)` and stores the answer; a hit says `cached` in
 *      the rationale and writes no `ai_usage` row;
 *   4. per-field `validateProposal`: a field naming an option id absent from
 *      the live enum (or anything else the registry refuses) is dropped and
 *      counted in the rationale, never written and never failing the run;
 *   5. `toPatch` — a claim on a person-targeted `record_reference` (a
 *      company's `founders`, a deal's `people`, `referred_by`) becomes one
 *      `suggestion(kind: 'identity')` per person on the same record, citing
 *      that field's refs and naming the field (SPA-105, SPA-160); accepting
 *      one is `resolveEntity`, a `contact_at` link, and the person written
 *      into that field.
 *      A claim on any other target (a deal's `company`) is held back with a
 *      rationale line — no accept path resolves it yet.
 *
 * Every model call runs before any suggestion is written, so a provider that
 * fails on the second record leaves no half-read deck in the inbox. A person
 * target is skipped with a line in the rationale, not read.
 *
 * **Kind is kind.** The trigger and this program read `document.kind` and
 * nothing else — there is no column saying how the kind was set, and nothing
 * here would branch on one if there were.
 *
 * **A captured page is the third caller (SPA-134).** `against` swaps the
 * filed records for one declared object and one anchor: the page is read
 * against that object's registry — person for a profile, company for a
 * company page — through the same `cachedExtractProgram` call, the same
 * validator and the same `proposeProgram`, and what it proposes is anchored
 * on the captured document itself (`./capture-read.ts`), since a capture
 * usually names somebody we hold no record for. Read as a person, the schema
 * gains one field, `_subject` — a person reference, so its answer is the
 * same identity claim a deck's `founders` yields — and the page's subject
 * becomes one `identity` suggestion ahead of one `attribute_patch`. Every
 * other reference claim is held back: with no record, nothing could hold it.
 * A document that already carries a capture read's suggestions is not read
 * again, so a re-posted page opens nothing new.
 */

export const READ_DECK_CONTEXT_CHARS = 12_000
/**
 * The extraction cache's purpose for this reader. Bump the version when the
 * task prompt changes what a stored answer would mean.
 */
export const READ_DECK_PURPOSE = 'read-deck/v1'
export const READ_DECK_BUDGET_CHARS = 24_000
/** The cache's purpose for a captured page: its task prompt is its own. */
export const READ_CAPTURE_PURPOSE = 'read-capture/v1'

/**
 * The field a person page's subject is claimed through (SPA-134). Not an
 * attribute: an attribute slug never starts with `_` (the slugifier trims
 * it), so it cannot shadow one, and it never reaches a patch.
 */
export const PAGE_SUBJECT_SLUG = '_subject'

const PAGE_SUBJECT: SchemaAttribute = {
  slug: PAGE_SUBJECT_SLUG,
  name: 'Who this page is about',
  description:
    'The person this page is about: their name as the page gives it, their role or title, and their email or LinkedIn URL when the page states them',
  type: 'record_reference',
  options: { targetKind: 'person', multi: false },
  archived: false,
}

const KIND_LABEL: Record<string, string> = {
  company: 'company',
  deal: 'deal',
  custom: 'record',
  person: 'person',
}

export class ReadDeckRefused extends Schema.TaggedError<ReadDeckRefused>()(
  'ReadDeckRefused',
  { message: Schema.String },
) {}

export class ReadDeckQueryFailed extends Schema.TaggedError<ReadDeckQueryFailed>()(
  'ReadDeckQueryFailed',
  { cause: Schema.Defect() },
) {}

export type ReadDeckFailure =
  | ReadDeckRefused
  | ReadDeckQueryFailed
  | CompleteFailure
  | SuggestionFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ReadDeckQueryFailed({ cause }),
  })

/**
 * The sentence a failed run leaves on its job — and so what the Files tab's
 * toast says. A provider that answered with an error, or could not be
 * reached, keeps its own words (`providerFailure`).
 */
export function readDeckMessage(failure: ReadDeckFailure): string {
  switch (failure._tag) {
    case 'ReadDeckRefused':
      return failure.message
    case 'ReadDeckQueryFailed':
      return 'Could not read the deck'
    case 'SensitivityReadFailed':
      return 'Could not read the record’s sensitivity'
    case 'SensitivityEntityNotFound':
      return 'A record the deck is filed against no longer exists'
    case 'ProviderCallFailed':
      return `${completeMessage(failure)}: ${providerFailure(failure.cause).message}`
    case 'SuggestionNotFound':
    case 'SuggestionNotOpen':
    case 'UnsupportedSuggestionKind':
    case 'SuggestionInvalid':
    case 'EntityNotFound':
    case 'SuggestionWriteFailed':
      return suggestionMessage(failure)
    default:
      // Every other failure is `complete()`'s — the unrouted lane, the
      // sensitive refusal, a cap — and `completeMessage` stays exhaustive
      // over them as that union grows.
      return completeMessage(failure)
  }
}

export type ReadDeckInput = {
  documentId: string
  /** Who pressed Read deck — `ai_usage.caller`, and whose context is read. */
  userId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  /** ISO 8601; defaults to now. */
  asOf?: string
  jobRunId?: string
  /**
   * The run this read is a step of (SPA-100) — "Read deck and summarize"
   * opens one and hands it here. Absent, the read opens and closes its own
   * one-step run ("Read deck").
   */
  runId?: string
  /**
   * A captured page (SPA-134): read against this object's registry rather
   * than the records the document is filed on, and propose onto
   * `anchorEntityId` — the captured document's own entity. Absent, the deck
   * reader it always was.
   */
  against?: { objectId: string; anchorEntityId: string }
}

export type ReadDeckResult = {
  suggestions: Array<Suggestion>
  /** Records filed against that got no model call, and why. */
  skipped: Array<{ entityId: string; reason: string }>
}

type Target = { id: string; kind: string; name: string }

/** A person the deck named, off one person-targeted reference field. */
type PersonClaim = { slug: string; claim: IdentityClaim; refs: Array<string> }

/** A captured page's read: the declared object and its live registry. */
type Against = {
  object: CaptureObject
  registry: ReadonlyArray<SchemaAttribute>
  anchorEntityId: string
}

type Read = {
  target: Target
  registry: ReadonlyArray<SchemaAttribute>
  proposal: Proposal
  dropped: Array<string>
  people: Array<PersonClaim>
  /** A captured person page: who it is about, off `_subject`. */
  subject: PersonClaim | null
  /** Reference slugs held back: claims on a target that is not a person. */
  heldBack: Array<string>
  /** Set when the extraction cache answered: who read it, and when. */
  cached: { model: string; at: string } | null
  /** The run step this read is, its output filled in once it has proposed. */
  step: RunStepInput
}

/** Deck text as context items — the chunks, or the extracted text whole. */
const deckItems = Effect.fn('readDeck.deckItems')(function* (
  documentId: string,
  label: string,
  extractedText: string | null,
  at: string,
): Effect.fn.Return<Array<ContextItem>, ReadDeckQueryFailed> {
  const chunks = yield* query(() =>
    db
      .select({ idx: chunk.idx, text: chunk.text })
      .from(chunk)
      .where(
        and(eq(chunk.entityId, documentId), eq(chunk.sourceKind, 'document')),
      )
      .orderBy(asc(chunk.idx)),
  )
  if (chunks.length > 0)
    return chunks.map((c) => ({
      ref: ref.doc(documentId, c.idx),
      kind: 'doc_chunk',
      text: `${label} p.${String(c.idx + 1)}: ${c.text}`,
      entityIds: [documentId],
      at,
    }))
  // Before ai-10b chunks anything: the document itself, as one item. The
  // ref grammar has no bare-document form, so it is chunk 0 — the whole of
  // what exists — and a citation still resolves to the deck.
  const text = extractedText?.trim() ?? ''
  if (text === '') return []
  return [
    {
      ref: ref.doc(documentId, 0),
      kind: 'doc_chunk',
      text: `${label}: ${text}`,
      entityIds: [documentId],
      at,
    },
  ]
})

/**
 * One field at a time through the validator, so a field the registry refuses
 * is dropped and named rather than sinking the whole proposal.
 */
function keepValid(
  registry: ReadonlyArray<SchemaAttribute>,
  raw: unknown,
): { proposal: Proposal; dropped: Array<string> } {
  const proposal: Proposal = {}
  const dropped: Array<string> = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { proposal, dropped }
  // In registry order, not the answer's: an answer read back from the
  // extraction cache's jsonb comes with its keys reordered, and the
  // suggestion's refs (the union, in field order) must not depend on which.
  const rank = (slug: string) => {
    const i = registry.findIndex((d) => d.slug === slug)
    return i < 0 ? registry.length : i
  }
  const entries = Object.entries(raw).sort(
    ([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  )
  for (const [slug, entry] of entries) {
    const checked = validateProposal(registry, { [slug]: entry })
    if (checked.ok) Object.assign(proposal, checked.proposal)
    else dropped.push(...checked.issues.map((i) => i.message))
  }
  return { proposal, dropped }
}

const TASK = (target: Target, filename: string) =>
  [
    `Read the pitch deck "${filename}" above and fill in what it states about the ${KIND_LABEL[target.kind] ?? 'record'} "${target.name}".`,
    'Use only facts the context states. Omit any field the context does not state; never guess.',
    'For each field, list in `refs` the bracketed refs of the context items the value was read from, and give a confidence between 0 and 1.',
  ].join('\n')

const CAPTURE_TASK = (against: Against, title: string) =>
  [
    `Read the captured page "${title}" above and fill in what it states about the ${against.object.singular.toLowerCase()} it describes.`,
    'Use only facts the context states. Omit any field the context does not state; never guess.',
    'For each field, list in `refs` the bracketed refs of the context items the value was read from, and give a confidence between 0 and 1.',
  ].join('\n')

/** The declared object, read once before the run opens: it names the run. */
const againstOf = Effect.fn('readDeck.against')(function* (
  against: NonNullable<ReadDeckInput['against']>,
): Effect.fn.Return<Against, ReadDeckRefused | ReadDeckQueryFailed> {
  const object = yield* query(() => captureObjectById(db, against.objectId))
  if (object === null)
    return yield* new ReadDeckRefused({
      message: 'The object the page was captured as no longer exists',
    })
  const registry = yield* query(() => getRegistryByObjectId(object.id))
  return { object, registry, anchorEntityId: against.anchorEntityId }
})

export const readDeckProgram = Effect.fn('readDeck')(function* (
  input: ReadDeckInput,
): Effect.fn.Return<ReadDeckResult, ReadDeckFailure> {
  const against =
    input.against === undefined ? null : yield* againstOf(input.against)
  return yield* withRun(
    input.runId,
    {
      task:
        against === null ? 'Read deck' : captureReadTask(against.object.slug),
      entityId: input.documentId,
      startedBy: { type: 'user', id: input.userId },
    },
    (run) => readDeckInRun(input, against, run),
    readDeckMessage,
  )
})

/**
 * A captured page's text before its extraction lands: the blob is the text,
 * byte for byte what was posted (`lib/rpc/capture.ts`), so the read need not
 * wait on the extract job to run.
 */
const pageText = (
  doc: { text: string | null; status: string; mime: string | null },
  blobSha: string | null,
) =>
  doc.status === 'done' ||
  blobSha === null ||
  !(doc.mime ?? '').startsWith('text/plain')
    ? Effect.succeed(doc.text)
    : query(async () =>
        Buffer.from(await storage().getBytes(blobSha)).toString('utf8'),
      )

/** Has a capture read of this page already proposed? Then it is not re-read. */
const alreadyRead = (anchorEntityId: string) =>
  query(
    async () =>
      (
        await db
          .select({ id: suggestion.id })
          .from(suggestion)
          .where(
            and(
              eq(suggestion.entityId, anchorEntityId),
              inArray(suggestion.kind, ['identity', 'attribute_patch']),
            ),
          )
          .limit(1)
      ).length > 0,
  )

const readDeckInRun = Effect.fn('readDeck.inRun')(function* (
  input: ReadDeckInput,
  against: Against | null,
  run: RunScope,
): Effect.fn.Return<ReadDeckResult, ReadDeckFailure> {
  const doc = (yield* query(() =>
    db
      .select({
        filename: document.filename,
        url: document.url,
        mime: document.mime,
        kind: document.kind,
        status: document.extractionStatus,
        text: document.extractedText,
        blobSha: document.blobSha,
        createdAt: document.createdAt,
        name: entity.canonicalName,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(eq(document.entityId, input.documentId)),
  )).at(0)
  if (!doc)
    return yield* new ReadDeckRefused({ message: 'That document is gone' })
  if (against === null && doc.kind !== 'deck')
    return yield* new ReadDeckRefused({ message: 'Only a deck is read' })
  if (against === null && doc.status !== 'done')
    return yield* new ReadDeckRefused({
      message: 'The deck’s text is not extracted yet',
    })
  if (against !== null && (yield* alreadyRead(against.anchorEntityId)))
    return {
      suggestions: [],
      skipped: [
        {
          entityId: against.anchorEntityId,
          reason: 'Already read: this page’s suggestions are in the inbox',
        },
      ],
    }

  const filename = doc.filename ?? doc.name
  const deck = yield* deckItems(
    input.documentId,
    against === null
      ? filename
      : `Captured page "${filename}"${doc.url === null ? '' : ` at ${doc.url}`}`,
    against === null ? doc.text : yield* pageText(doc, doc.blobSha),
    doc.createdAt.toISOString(),
  )
  if (deck.length === 0)
    return yield* new ReadDeckRefused({
      message:
        against === null ? 'The deck has no text' : 'The page has no text',
    })

  const filed = yield* query(() =>
    db
      .select({ id: entity.id, kind: entity.kind, name: entity.canonicalName })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(
          eq(link.fromEntityId, input.documentId),
          eq(link.relation, 'tagged_in'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(entity.kind), asc(entity.canonicalName)),
  )

  const skipped: ReadDeckResult['skipped'] = []
  // A captured page has one target: its own document, read as the object
  // the capture declared.
  const targets: Array<Target> =
    against === null
      ? []
      : [
          {
            id: against.anchorEntityId,
            kind: against.object.kind ?? 'custom',
            name: filename,
          },
        ]
  // Not the records it is filed on: a capture filed on a company is still
  // read as the object it declared, once.
  for (const t of against === null ? filed : []) {
    if (t.kind === 'company' || t.kind === 'deal' || t.kind === 'custom')
      targets.push(t)
    else if (t.kind === 'person')
      skipped.push({
        entityId: t.id,
        reason: `Not read against ${t.name}: a deck describes a company or a deal, not a person`,
      })
  }
  if (targets.length === 0)
    return yield* new ReadDeckRefused({
      message: 'The deck is not filed against a company or a deal',
    })

  const asOf = input.asOf ?? new Date().toISOString()
  // Every refusal is behind us: the run opens here, at its first call.
  const runId = yield* run.id
  const reads: Array<Read> = []
  // Sequential on purpose: each call is its own `ai_usage` row and its own
  // provider request, and nothing is written until every one has answered.
  // Sequential also lets a second record over the same schema hit the cache
  // row the first one's call just stored.
  for (const target of targets) {
    const registry: ReadonlyArray<SchemaAttribute> =
      against === null
        ? yield* query(() => registryFor(db, target.id))
        : against.object.kind === 'person'
          ? [PAGE_SUBJECT, ...against.registry]
          : against.registry
    // A captured page has no record to bring context from: the page is all.
    const context =
      against !== null
        ? { items: [] }
        : yield* recordContextProgram({
            entityId: target.id,
            user: { id: input.userId },
            asOf,
            budgetChars: READ_DECK_CONTEXT_CHARS,
          }).pipe(
            Effect.mapError((cause) => new ReadDeckQueryFailed({ cause })),
          )
    const items: Array<ContextItem> = [
      ...deck,
      ...context.items.map((i) => ({
        ref: i.ref,
        kind: i.kind,
        text: i.text,
        entityIds: [target.id],
        at: i.at,
      })),
    ]
    const sensitivity = yield* sensitivityFor(target.id)
    const answered = yield* cachedExtractProgram(
      {
        blobSha: doc.blobSha,
        documentId: input.documentId,
        purpose: against === null ? READ_DECK_PURPOSE : READ_CAPTURE_PURPOSE,
      },
      items,
      schemaFor(
        registry,
        against === null
          ? `${KIND_LABEL[target.kind] ?? 'record'} fields`
          : `${against.object.singular.toLowerCase()} fields`,
      ),
      {
        caller: { type: 'user', id: input.userId },
        sensitivity: sensitivity.sensitivity,
        ...(sensitivity.sensitivity === 'sensitive'
          ? { via: sensitivity.via }
          : {}),
        budgetChars: READ_DECK_BUDGET_CHARS,
        task:
          against === null
            ? TASK(target, filename)
            : CAPTURE_TASK(against, filename),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
        runId,
      },
    )
    const raw =
      answered.output.kind === 'object' ? answered.output.object : undefined
    const { proposal, dropped } = keepValid(registry, raw)
    const { claims } = toPatch(registry, proposal)
    const people: Array<PersonClaim> = []
    const heldBack: Array<string> = []
    let subject: PersonClaim | null = null
    for (const [slug, list] of Object.entries(claims)) {
      const { refs } = proposal[slug]
      Reflect.deleteProperty(proposal, slug)
      const def = registry.find((d) => d.slug === slug)
      const claim = list.at(0)
      if (slug === PAGE_SUBJECT_SLUG) {
        if (claim !== undefined) subject = { slug, claim, refs }
      } else if (against === null && def?.options.targetKind === 'person')
        for (const c of list) people.push({ slug, claim: c, refs })
      else heldBack.push(slug)
    }
    reads.push({
      target,
      registry,
      proposal,
      dropped,
      people,
      subject,
      heldBack,
      cached:
        answered.cachedAt === null
          ? null
          : { model: answered.target.model, at: answered.cachedAt },
      step: callStep(
        'extract',
        items.map((i) => i.ref),
        answered,
        null,
        input.jobRunId,
      ),
    })
  }

  const suggestions: Array<Suggestion> = []
  for (const read of reads) {
    if (
      Object.keys(read.proposal).length === 0 &&
      read.people.length === 0 &&
      read.subject === null
    ) {
      skipped.push({
        entityId: read.target.id,
        reason: `Nothing in ${filename} held for ${read.target.name}`,
      })
      yield* run.step(read.step)
      continue
    }
    const first = suggestions.length
    // A captured page's subject first: accepting it is what gives the patch
    // below its record, and "Accept all" takes a card oldest first.
    if (read.subject !== null)
      suggestions.push(
        yield* proposeProgram({
          entityId: read.target.id,
          kind: 'identity',
          payload: identityPayloadOf(read.subject.claim),
          rationale: subjectRationale(read.subject, filename),
          refs: read.subject.refs,
          runId,
          proposedBy: { type: 'user', id: input.userId },
        }),
      )
    if (Object.keys(read.proposal).length > 0) {
      // The values came off the wire as JSON and passed the validators, so
      // this decode is the type's claim made once, not a filter that bites.
      const payload = jsonValue.safeParse(read.proposal)
      if (!payload.success)
        return yield* new ReadDeckRefused({
          message: 'The model answered with something that is not JSON',
        })
      suggestions.push(
        yield* proposeProgram({
          entityId: read.target.id,
          kind: 'attribute_patch',
          payload: payload.data,
          rationale:
            against === null
              ? rationaleFor(read, reads, filename, skipped)
              : captureRationale(read, against, filename),
          refs: proposalRefs(read.proposal),
          runId,
          proposedBy: { type: 'user', id: input.userId },
        }),
      )
    }
    // After the patch, on the same record: one identity per person named,
    // each its own decision in the inbox, accepted or rejected alone.
    for (const person of read.people)
      suggestions.push(
        yield* proposeProgram({
          entityId: read.target.id,
          kind: 'identity',
          payload: identityPayloadOf(person.claim, person.slug),
          rationale: identityRationale(person, read, filename),
          refs: person.refs,
          runId,
          proposedBy: { type: 'user', id: input.userId },
        }),
      )
    // One step per call, in call order; its output is the first suggestion
    // it wrote — the run's whole yield is every `suggestion.run_id` row.
    const out = suggestions.at(first)
    yield* run.step({
      ...read.step,
      outputRef: out === undefined ? null : suggestionOutputRef(out.id),
    })
  }
  return { suggestions, skipped }
})

function rationaleFor(
  read: Read,
  reads: ReadonlyArray<Read>,
  filename: string,
  skipped: ReadDeckResult['skipped'],
): string {
  const fields = Object.keys(read.proposal).length
  const kind = KIND_LABEL[read.target.kind] ?? 'record'
  const lines = [
    `Read from ${filename} against the ${kind} fields: ${String(fields)} field${fields === 1 ? '' : 's'} proposed.`,
  ]
  if (read.cached !== null)
    lines.push(
      `Answered from the extraction cache (cached): ${read.cached.model} read these bytes against these fields at ${read.cached.at}, so no provider call was made and no usage was recorded.`,
    )
  if (reads.length > 1) {
    const others = reads
      .filter((r) => r !== read)
      .map((r) => `${KIND_LABEL[r.target.kind] ?? 'record'} ${r.target.name}`)
    const cachedReads = reads.filter((r) => r.cached !== null).length
    lines.push(
      cachedReads === 0
        ? `${String(reads.length)} model calls were made — one per filed record, each against its own fields; the others read ${others.join(', ')}.`
        : `${String(reads.length)} reads were made — one per filed record, each against its own fields, ${String(reads.length - cachedReads)} by a model call and ${String(cachedReads)} from the extraction cache; the others read ${others.join(', ')}.`,
    )
  }
  if (read.dropped.length > 0)
    lines.push(
      `${String(read.dropped.length)} proposed field${read.dropped.length === 1 ? ' was' : 's were'} dropped at validation: ${read.dropped.join('; ')}.`,
    )
  if (read.people.length > 0)
    lines.push(
      `${String(read.people.length)} ${read.people.length === 1 ? 'person' : 'people'} named in the deck ${read.people.length === 1 ? 'is' : 'are'} proposed separately, as identities.`,
    )
  if (read.heldBack.length > 0)
    lines.push(
      `Held back ${read.heldBack.join(', ')}: a proposed reference to a record that is not a person is not written yet.`,
    )
  for (const s of skipped) lines.push(`${s.reason}.`)
  return lines.join('\n')
}

/** Why a captured page's patch is on the page, and where it will land. */
function captureRationale(read: Read, against: Against, title: string): string {
  const fields = Object.keys(read.proposal).length
  const what = against.object.singular.toLowerCase()
  const lines = [
    `Read from the captured page ${title} against the ${what} fields: ${String(fields)} field${fields === 1 ? '' : 's'} proposed.`,
  ]
  if (read.cached !== null)
    lines.push(
      `Answered from the extraction cache (cached): ${read.cached.model} read these bytes against these fields at ${read.cached.at}, so no provider call was made and no usage was recorded.`,
    )
  if (read.dropped.length > 0)
    lines.push(
      `${String(read.dropped.length)} proposed field${read.dropped.length === 1 ? ' was' : 's were'} dropped at validation: ${read.dropped.join('; ')}.`,
    )
  lines.push(
    read.subject !== null
      ? `These apply to the ${what} the identity above matches or creates, once it is accepted.`
      : `These apply to the ${what} the page is filed on.`,
  )
  if (read.heldBack.length > 0)
    lines.push(
      `Held back ${read.heldBack.join(', ')}: a captured page has no record to hold a reference on.`,
    )
  return lines.join('\n')
}

/** Why a captured page's identity is on the page: who it is about. */
function subjectRationale(subject: PersonClaim, title: string): string {
  const as = subject.claim.role === undefined ? '' : `, ${subject.claim.role}`
  const keys = [
    subject.claim.email === undefined ? null : 'email',
    subject.claim.linkedin === undefined ? null : 'LinkedIn',
  ].filter((k) => k !== null)
  return [
    `${subject.claim.name}${as} — from a captured page, ${title}.`,
    keys.length > 0
      ? `Accepting matches an existing person by ${keys.join(' or ')}, else creates one, and files the page on them; the page’s fields then apply to that person.`
      : 'No email or LinkedIn given: accepting creates a person and files the page on them — a near-identical name already held is filed as a duplicate candidate; the page’s fields then apply to that person.',
  ].join('\n')
}

/**
 * Why an identity is on this record: who named them, where, as what. The
 * provenance `entity_source: 'import'` cannot carry lives here and in the
 * row's refs (SPA-105).
 */
function identityRationale(
  person: PersonClaim,
  read: Read,
  filename: string,
): string {
  const def = read.registry.find((d) => d.slug === person.slug)
  const kind = KIND_LABEL[read.target.kind] ?? 'record'
  const as = person.claim.role === undefined ? '' : ` as ${person.claim.role}`
  const keys = [
    person.claim.email === undefined ? null : 'email',
    person.claim.linkedin === undefined ? null : 'LinkedIn',
  ].filter((k) => k !== null)
  return [
    `Named in ${filename}${as}, read against the ${kind} field ${def?.name ?? person.slug}.`,
    keys.length > 0
      ? `Accepting matches an existing person by ${keys.join(' or ')}, else creates one, links them contact at ${read.target.name} and sets them in ${def?.name ?? person.slug}.`
      : `No email or LinkedIn given: accepting creates a person, links them contact at ${read.target.name} and sets them in ${def?.name ?? person.slug}; a near-identical name already held is filed as a duplicate candidate.`,
  ].join('\n')
}

// ---------- trigger + status (the Files tab's two server fns) ----------

export type ReadDeckEnqueued =
  | { status: 'queued' }
  | { status: 'already-reading' }
  | { status: 'queue-unavailable' }

/**
 * Press Read deck: one job keyed on the document. The queue is `exclusive`,
 * so pg-boss itself refuses a second send while one is queued or active and
 * answers `null`; the jobs read back tell that refusal from a queue that is
 * down.
 *
 * `summarizeOnto` is Read deck and summarize (SPA-100): the same job, keyed
 * the same, with the record the summary lands on — one read of a deck at a
 * time, whichever button pressed it.
 */
export const enqueueReadDeckProgram = Effect.fn('enqueueReadDeck')(function* (
  documentId: string,
  userId: string,
  summarizeOnto?: string,
): Effect.fn.Return<ReadDeckEnqueued, ReadDeckRefused | ReadDeckQueryFailed> {
  const doc = (yield* query(() =>
    db
      .select({ kind: document.kind, status: document.extractionStatus })
      .from(document)
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (!doc)
    return yield* new ReadDeckRefused({ message: 'That document is gone' })
  if (doc.kind !== 'deck' || doc.status !== 'done')
    return yield* new ReadDeckRefused({
      message: 'Only a deck whose text is extracted can be read',
    })
  const jobId = yield* query(() =>
    enqueue(
      QUEUES.readDeck,
      summarizeOnto === undefined
        ? { documentId, userId }
        : { documentId, userId, summarizeOnto },
      { singletonKey: documentId },
    ),
  )
  if (jobId !== null) return { status: 'queued' }
  const jobs = yield* query(() => jobsByKey(QUEUES.readDeck, documentId))
  return jobs !== null && jobs.some(inFlight)
    ? { status: 'already-reading' }
    : { status: 'queue-unavailable' }
})

/** What `POST /api/v1/capture` answers about the read behind it. */
export type CaptureReadQueued = 'queued' | 'skipped'

/**
 * Queue a captured page's read (SPA-134) — the Read deck job with `capture`
 * set, keyed on the document as Read deck is, so pg-boss refuses a second
 * send while one is queued or active. Routed first, at the page's own
 * sensitivity: with no model for the extract lane there is no job and no
 * suggestion, and the capture still answers — `skipped`, never a failure,
 * so the endpoint never fails for want of a model key. A queue that is down
 * is `skipped` too: nothing will read the page.
 */
export const enqueueCaptureReadProgram = Effect.fn('enqueueCaptureRead')(
  function* (input: {
    documentId: string
    userId: string
    objectId: string
  }): Effect.fn.Return<CaptureReadQueued> {
    const routed = yield* isLaneRoutedProgram('extract', input.userId)
    if (!routed.normal && !routed.sensitive) return 'skipped'
    const read = yield* Effect.result(sensitivityFor(input.documentId))
    if (read._tag === 'Failure' || !routed[read.success.sensitivity])
      return 'skipped'
    const { documentId, userId, objectId } = input
    const jobId = yield* Effect.promise(() =>
      enqueue(
        QUEUES.readDeck,
        { documentId, userId, capture: { objectId } },
        { singletonKey: documentId },
      ),
    )
    if (jobId !== null) return 'queued'
    const jobs = yield* Effect.promise(() =>
      jobsByKey(QUEUES.readDeck, documentId),
    )
    return jobs !== null && jobs.some(inFlight) ? 'queued' : 'skipped'
  },
)

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

export type ReadDeckStatus =
  | { state: 'idle' }
  | { state: 'reading' }
  | { state: 'done'; at: string }
  | { state: 'failed'; message: string; at: string }

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
function reasonOf(output: object | null): string | null {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** The latest job for a document, as the button reads it. */
export function statusOf(jobs: ReadonlyArray<QueuedJob>): ReadDeckStatus {
  const latest = [...jobs]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { state: 'idle' }
  if (inFlight(latest)) return { state: 'reading' }
  const at = latest.createdOn.toISOString()
  if (latest.state === 'completed') return { state: 'done', at }
  return {
    state: 'failed',
    message: reasonOf(latest.output) ?? 'The deck could not be read',
    at,
  }
}

export const readDeckStatusProgram = Effect.fn('readDeckStatus')(function* (
  documentIds: ReadonlyArray<string>,
): Effect.fn.Return<Record<string, ReadDeckStatus>, ReadDeckQueryFailed> {
  const out: Record<string, ReadDeckStatus> = {}
  for (const id of documentIds) {
    const jobs = yield* query(() => jobsByKey(QUEUES.readDeck, id))
    out[id] = jobs === null ? { state: 'idle' } : statusOf(jobs)
  }
  return out
})
