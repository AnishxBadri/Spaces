import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { document, documentChunk, entity, link } from '@spaces/db/schema'
import {
  proposalRefs,
  schemaFor,
  toPatch,
  validateProposal,
} from '@spaces/core/ai/schema'
import type { Proposal } from '@spaces/core/ai/schema'
import type { AttributeDef } from '@spaces/core/attributes/registry'
import { QUEUES } from '@spaces/core/queue/names'
import { recordContextProgram } from '#/lib/context/record'
import { ref } from '#/lib/context/ref'
import type { ContextItem } from '#/lib/context/types'
import { jsonValue } from '#/lib/json'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { completeMessage, completeProgram } from './complete'
import type { CompleteFailure } from './complete'
import { proposeProgram, registryFor, suggestionMessage } from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
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
 *      `document_chunk` rows exist, else the extracted text whole as
 *      `doc:<id>#0`), then `recordContextProgram` on the record, which brings
 *      the space memos, the mandate and the glossary for free;
 *   2. `sensitivityFor(record)` — live, never cached — spread into the call;
 *   3. `completeProgram('extract', items, schemaFor(registry), …)`;
 *   4. per-field `validateProposal`: a field naming an option id absent from
 *      the live enum (or anything else the registry refuses) is dropped and
 *      counted in the rationale, never written and never failing the run;
 *   5. `toPatch` — identity claims (`record_reference`) are held back with a
 *      rationale line; founders are SPA-105's.
 *
 * Every model call runs before any suggestion is written, so a provider that
 * fails on the second record leaves no half-read deck in the inbox. A person
 * target is skipped with a line in the rationale, not read.
 *
 * **Kind is kind.** The trigger and this program read `document.kind` and
 * nothing else — there is no column saying how the kind was set, and nothing
 * here would branch on one if there were.
 */

export const READ_DECK_CONTEXT_CHARS = 12_000
export const READ_DECK_BUDGET_CHARS = 24_000

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
}

export type ReadDeckResult = {
  suggestions: Array<Suggestion>
  /** Records filed against that got no model call, and why. */
  skipped: Array<{ entityId: string; reason: string }>
}

type Target = { id: string; kind: string; name: string }

type Read = {
  target: Target
  registry: Array<AttributeDef>
  proposal: Proposal
  dropped: Array<string>
  claims: Array<string>
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
      .select({ idx: documentChunk.idx, text: documentChunk.text })
      .from(documentChunk)
      .where(eq(documentChunk.documentId, documentId))
      .orderBy(asc(documentChunk.idx)),
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
  registry: ReadonlyArray<AttributeDef>,
  raw: unknown,
): { proposal: Proposal; dropped: Array<string> } {
  const proposal: Proposal = {}
  const dropped: Array<string> = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { proposal, dropped }
  for (const [slug, entry] of Object.entries(raw)) {
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

export const readDeckProgram = Effect.fn('readDeck')(function* (
  input: ReadDeckInput,
): Effect.fn.Return<ReadDeckResult, ReadDeckFailure> {
  const doc = (yield* query(() =>
    db
      .select({
        filename: document.filename,
        kind: document.kind,
        status: document.extractionStatus,
        text: document.extractedText,
        createdAt: document.createdAt,
        name: entity.canonicalName,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(eq(document.entityId, input.documentId)),
  )).at(0)
  if (!doc)
    return yield* new ReadDeckRefused({ message: 'That document is gone' })
  if (doc.kind !== 'deck')
    return yield* new ReadDeckRefused({ message: 'Only a deck is read' })
  if (doc.status !== 'done')
    return yield* new ReadDeckRefused({
      message: 'The deck’s text is not extracted yet',
    })

  const filename = doc.filename ?? doc.name
  const deck = yield* deckItems(
    input.documentId,
    filename,
    doc.text,
    doc.createdAt.toISOString(),
  )
  if (deck.length === 0)
    return yield* new ReadDeckRefused({ message: 'The deck has no text' })

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
  const targets: Array<Target> = []
  for (const t of filed) {
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
  const reads: Array<Read> = []
  // Sequential on purpose: each call is its own `ai_usage` row and its own
  // provider request, and nothing is written until every one has answered.
  for (const target of targets) {
    const registry = yield* query(() => registryFor(db, target.id))
    const context = yield* recordContextProgram({
      entityId: target.id,
      user: { id: input.userId },
      asOf,
      budgetChars: READ_DECK_CONTEXT_CHARS,
    }).pipe(Effect.mapError((cause) => new ReadDeckQueryFailed({ cause })))
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
    const answered = yield* completeProgram(
      'extract',
      items,
      schemaFor(registry, `${KIND_LABEL[target.kind] ?? 'record'} fields`),
      {
        caller: { type: 'user', id: input.userId },
        sensitivity: sensitivity.sensitivity,
        ...(sensitivity.sensitivity === 'sensitive'
          ? { via: sensitivity.via }
          : {}),
        budgetChars: READ_DECK_BUDGET_CHARS,
        task: TASK(target, filename),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
      },
    )
    const raw =
      answered.output.kind === 'object' ? answered.output.object : undefined
    const { proposal, dropped } = keepValid(registry, raw)
    const { claims } = toPatch(registry, proposal)
    for (const slug of Object.keys(claims))
      Reflect.deleteProperty(proposal, slug)
    reads.push({
      target,
      registry,
      proposal,
      dropped,
      claims: Object.keys(claims),
    })
  }

  const suggestions: Array<Suggestion> = []
  for (const read of reads) {
    if (Object.keys(read.proposal).length === 0) {
      skipped.push({
        entityId: read.target.id,
        reason: `Nothing in ${filename} held for ${read.target.name}`,
      })
      continue
    }
    // The values came off the wire as JSON and passed the validators, so this
    // decode is the type's claim made once, not a filter that bites.
    const payload = jsonValue.safeParse(read.proposal)
    if (!payload.success)
      return yield* new ReadDeckRefused({
        message: 'The model answered with something that is not JSON',
      })
    const row = yield* proposeProgram({
      entityId: read.target.id,
      kind: 'attribute_patch',
      payload: payload.data,
      rationale: rationaleFor(read, reads, filename, skipped),
      refs: proposalRefs(read.proposal),
      proposedBy: { type: 'user', id: input.userId },
    })
    suggestions.push(row)
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
  if (reads.length > 1) {
    const others = reads
      .filter((r) => r !== read)
      .map((r) => `${KIND_LABEL[r.target.kind] ?? 'record'} ${r.target.name}`)
    lines.push(
      `${String(reads.length)} model calls were made — one per filed record, each against its own fields; the others read ${others.join(', ')}.`,
    )
  }
  if (read.dropped.length > 0)
    lines.push(
      `${String(read.dropped.length)} proposed field${read.dropped.length === 1 ? ' was' : 's were'} dropped at validation: ${read.dropped.join('; ')}.`,
    )
  if (read.claims.length > 0)
    lines.push(
      `Held back ${read.claims.join(', ')}: a proposed record reference is not written yet.`,
    )
  for (const s of skipped) lines.push(`${s.reason}.`)
  return lines.join('\n')
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
 */
export const enqueueReadDeckProgram = Effect.fn('enqueueReadDeck')(function* (
  documentId: string,
  userId: string,
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
      { documentId, userId },
      { singletonKey: documentId },
    ),
  )
  if (jobId !== null) return { status: 'queued' }
  const jobs = yield* query(() => jobsByKey(QUEUES.readDeck, documentId))
  return jobs !== null && jobs.some(inFlight)
    ? { status: 'already-reading' }
    : { status: 'queue-unavailable' }
})

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
