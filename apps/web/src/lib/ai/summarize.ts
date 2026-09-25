import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { chunk, document, entity, note } from '@spaces/db/schema'
import type { NotePayload } from '@spaces/core/ai/note'
import { QUEUES } from '@spaces/core/queue/names'
import { assembleProgram } from '#/lib/context/assemble'
import { resolveRefsProgram } from '#/lib/context/names'
import { parseRef, ref } from '#/lib/context/ref'
import type { ContextItem } from '#/lib/context/types'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { completeMessage, completeProgram } from './complete'
import type { CompleteFailure } from './complete'
import { inlineCitations } from './inline-citations'
import { proposeProgram, suggestionMessage } from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * Summarize (SPA-66; docs/spec-ai-substrate.md §11 "Summarize", §14 step
 * 5): the synthesize lane, landing as a `suggestion(kind: 'note')` on the
 * record the button was pressed on — never a note, a row in the inbox.
 * Accepting it is what writes the note (`acceptProgram` → `lib/notes/
 * from-suggestion.ts`).
 *
 * Two scopes, one path:
 *
 * - **a document** (the Files tab's Summarize): the document's own text
 *   first — every `chunk` row of it, labelled with its page, else the
 *   extracted text whole — then `assemble(document)` for what surrounds it
 *   (the records it is filed against, the mandate, the glossary). The
 *   assembler reaches a *linked* document's chunks, never the seed's own,
 *   which is why the document's text is read here.
 * - **a record** (the record header's Summarize): `assemble(record)` —
 *   its notes, memos and filed documents' chunks, its fields and history.
 *   A record none of whose own notes or documents reached the context
 *   refuses "Nothing to summarize" **before** the model is called: a
 *   summary of an empty context is a model inventing one.
 *
 * Either way: private notes are dropped from the context — the note this
 * lands as is `shared`, and a teammate's accept must not publish what only
 * the requester could read. Sensitivity is read live for the record and,
 * for a document, the document too; either sensitive makes the call
 * sensitive. Then `completeProgram('synthesize', items)` — text, no schema —
 * and every `[ref]` the model cited is rewritten into the words a person
 * reads (`inline-citations.ts`), so "(DD pack.pdf, p.4)" is in the body and
 * outlives the suggestion row. A cited ref the context did not carry is
 * dropped, not printed.
 */

/** The assembler's budget for the neighbourhood of the thing summarized. */
export const SUMMARIZE_CONTEXT_CHARS = 24_000
/**
 * The whole prompt, task included. Large on purpose: the synthesize lane is
 * the frontier tier, and a diligence pack is the material it is for. What
 * does not fit is cut at the tail by `renderPrompt`, the document's later
 * pages first.
 */
export const SUMMARIZE_BUDGET_CHARS = 120_000

export class SummarizeRefused extends Schema.TaggedError<SummarizeRefused>()(
  'SummarizeRefused',
  { message: Schema.String },
) {}

export class SummarizeQueryFailed extends Schema.TaggedError<SummarizeQueryFailed>()(
  'SummarizeQueryFailed',
  { cause: Schema.Defect() },
) {}

export type SummarizeFailure =
  | SummarizeRefused
  | SummarizeQueryFailed
  | CompleteFailure
  | SuggestionFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SummarizeQueryFailed({ cause }),
  })

/** The refusal an empty context gets, whichever scope it was. */
export const NOTHING_TO_SUMMARIZE = 'Nothing to summarize'

/**
 * The sentence a failed run leaves on its job — and so what the toast says.
 * A provider that answered with an error keeps its own words.
 */
export function summarizeMessage(failure: SummarizeFailure): string {
  switch (failure._tag) {
    case 'SummarizeRefused':
      return failure.message
    case 'SummarizeQueryFailed':
      return 'Could not read what to summarize'
    case 'SensitivityReadFailed':
      return 'Could not read the record’s sensitivity'
    case 'SensitivityEntityNotFound':
      return 'The record or document no longer exists'
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
      return completeMessage(failure)
  }
}

export type SummarizeInput = {
  /** The record the button was pressed on — where the suggestion sits. */
  recordId: string
  /** A document to summarize, or null to summarize the record itself. */
  documentId: string | null
  /** Who pressed Summarize — `ai_usage.caller`, and whose context is read. */
  userId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  /** ISO 8601; defaults to now. */
  asOf?: string
  jobRunId?: string
}

type Source = { id: string; name: string; what: string }

/** A document's own text as context items, one per chunk, page-labelled. */
const documentItems = Effect.fn('summarize.documentItems')(function* (
  documentId: string,
  label: string,
  extractedText: string | null,
  at: string,
): Effect.fn.Return<Array<ContextItem>, SummarizeQueryFailed> {
  const chunks = yield* query(() =>
    db
      .select({ idx: chunk.idx, text: chunk.text, page: chunk.page })
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
      text: `${label} ${where(c.page, c.idx)}: ${c.text}`,
      entityIds: [documentId],
      at,
    }))
  // Not chunked yet: the text whole, as chunk 0 — the grammar has no bare
  // document ref, and a citation of it still names the document.
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

/** Where in a document a chunk sits: its page when known, else its part. */
const where = (page: number | null, idx: number): string =>
  page === null ? `part ${String(idx + 1)}` : `p.${String(page)}`

/**
 * The words each ref becomes in the body. A document chunk is its filename
 * and page ("DD pack.pdf, p.4") — the page, not `cite.ts`'s chunk index,
 * because a person checks a citation against the PDF. Everything else is
 * `resolveRefsProgram`'s label; a missing target gets none, and is dropped.
 */
const citationLabels = Effect.fn('summarize.citationLabels')(function* (
  refs: ReadonlyArray<string>,
): Effect.fn.Return<Map<string, string>, SummarizeQueryFailed> {
  const labels = new Map<string, string>()
  const docs = new Map<string, Array<number>>()
  const rest: Array<string> = []
  for (const r of refs) {
    const p = parseRef(r)
    if (p?.kind === 'doc')
      docs.set(p.entityId, [...(docs.get(p.entityId) ?? []), p.idx])
    else rest.push(r)
  }
  if (docs.size > 0) {
    const ids = [...docs.keys()]
    const names = yield* query(() =>
      db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          filename: document.filename,
        })
        .from(entity)
        .leftJoin(document, eq(document.entityId, entity.id))
        .where(inArray(entity.id, ids)),
    )
    const pages = yield* query(() =>
      db
        .select({ id: chunk.entityId, idx: chunk.idx, page: chunk.page })
        .from(chunk)
        .where(
          and(inArray(chunk.entityId, ids), eq(chunk.sourceKind, 'document')),
        ),
    )
    for (const [id, idxs] of docs) {
      const n = names.find((x) => x.id === id)
      if (n === undefined) continue
      const label = n.filename ?? n.name
      for (const idx of idxs) {
        const page = pages.find((p) => p.id === id && p.idx === idx)
        labels.set(
          ref.doc(id, idx),
          page === undefined && idx === 0
            ? label
            : `${label}, ${where(page?.page ?? null, idx)}`,
        )
      }
    }
  }
  const resolved = yield* resolveRefsProgram(rest).pipe(
    Effect.mapError((cause) => new SummarizeQueryFailed({ cause })),
  )
  for (const r of resolved) if (!r.missing) labels.set(r.ref, r.label)
  return labels
})

/**
 * Drop every note and memo that is not `shared`. The assembler lets the
 * requester's own private notes through (`canRead`); the note this lands as
 * is shared, so they stay out.
 */
const sharedOnly = Effect.fn('summarize.sharedOnly')(function* (
  items: ReadonlyArray<ContextItem>,
): Effect.fn.Return<Array<ContextItem>, SummarizeQueryFailed> {
  const noteIds = new Set<string>()
  for (const i of items) {
    const p = parseRef(i.ref)
    if (p?.kind === 'note' || p?.kind === 'memo') noteIds.add(p.entityId)
  }
  if (noteIds.size === 0) return [...items]
  const rows = yield* query(() =>
    db
      .select({ id: note.entityId, visibility: note.visibility })
      .from(note)
      .where(inArray(note.entityId, [...noteIds])),
  )
  const privateIds = new Set(
    rows.filter((r) => r.visibility !== 'shared').map((r) => r.id),
  )
  return items.filter((i) => {
    const p = parseRef(i.ref)
    return !(
      (p?.kind === 'note' || p?.kind === 'memo') &&
      privateIds.has(p.entityId)
    )
  })
})

const TASK = (source: Source) =>
  [
    `Summarize ${source.what} for the team's notes, in markdown.`,
    'Use only what the context above states; never add a fact from elsewhere, and say plainly where the material is silent on something that matters.',
    'Open with a short overview paragraph, then `## ` sections with `- ` bullet points for the substance — whichever of business, market, traction, team, terms and risks the material covers.',
    'Cite every claim inline, right after it, with the bracketed ref of the context item it came from, exactly as written above — for example [doc:<id>#3]. Several refs share one bracket, separated by commas.',
    'Do not write a title line, and do not wrap the answer in a code fence.',
  ].join('\n')

export const summarizeProgram = Effect.fn('summarize')(function* (
  input: SummarizeInput,
): Effect.fn.Return<Suggestion, SummarizeFailure> {
  const record = (yield* query(() =>
    db
      .select({
        id: entity.id,
        kind: entity.kind,
        name: entity.canonicalName,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(entity)
      .where(eq(entity.id, input.recordId)),
  )).at(0)
  if (!record || record.mergedIntoId !== null)
    return yield* new SummarizeRefused({ message: 'That record is gone' })

  const asOf = input.asOf ?? new Date().toISOString()
  const user = { id: input.userId }
  let source: Source
  let items: Array<ContextItem>

  if (input.documentId !== null) {
    const documentId = input.documentId
    const doc = (yield* query(() =>
      db
        .select({
          filename: document.filename,
          status: document.extractionStatus,
          text: document.extractedText,
          createdAt: document.createdAt,
          name: entity.canonicalName,
        })
        .from(document)
        .innerJoin(entity, eq(entity.id, document.entityId))
        .where(eq(document.entityId, documentId)),
    )).at(0)
    if (!doc)
      return yield* new SummarizeRefused({ message: 'That document is gone' })
    if (doc.status !== 'done')
      return yield* new SummarizeRefused({
        message: 'The document’s text is not extracted yet',
      })
    const filename = doc.filename ?? doc.name
    source = {
      id: documentId,
      name: filename,
      what: `the document "${filename}"`,
    }
    const own = yield* documentItems(
      documentId,
      filename,
      doc.text,
      doc.createdAt.toISOString(),
    )
    if (own.length === 0)
      return yield* new SummarizeRefused({
        message: `${NOTHING_TO_SUMMARIZE}: ${filename} has no text`,
      })
    const around = yield* assembleProgram(
      { entityId: documentId },
      { user, asOf, budgetChars: SUMMARIZE_CONTEXT_CHARS },
    ).pipe(Effect.mapError((cause) => new SummarizeQueryFailed({ cause })))
    items = [...own, ...around.items]
  } else {
    source = {
      id: record.id,
      name: record.name,
      what: `what the notes and documents on the ${record.kind} "${record.name}" say`,
    }
    const assembled = yield* assembleProgram(
      { entityId: record.id },
      { user, asOf, budgetChars: SUMMARIZE_CONTEXT_CHARS },
    ).pipe(Effect.mapError((cause) => new SummarizeQueryFailed({ cause })))
    items = [...assembled.items]
  }

  items = yield* sharedOnly(items)
  if (input.documentId === null) {
    // The record's own notes, memos and documents — reached from it, not
    // from a space it sits in (a space memo's first entity is the space).
    const substance = items.filter(
      (i) =>
        (i.kind === 'note' || i.kind === 'memo' || i.kind === 'doc_chunk') &&
        i.entityIds[0] === record.id,
    )
    if (substance.length === 0)
      return yield* new SummarizeRefused({
        message: `${NOTHING_TO_SUMMARIZE}: ${record.name} has no notes and no documents`,
      })
  }

  const recordSensitivity = yield* sensitivityFor(record.id)
  const docSensitivity =
    input.documentId === null ? null : yield* sensitivityFor(input.documentId)
  const sensitive =
    docSensitivity?.sensitivity === 'sensitive'
      ? docSensitivity
      : recordSensitivity
  const answered = yield* completeProgram('synthesize', items, undefined, {
    caller: { type: 'user', id: input.userId },
    sensitivity: sensitive.sensitivity,
    ...(sensitive.sensitivity === 'sensitive' ? { via: sensitive.via } : {}),
    budgetChars: SUMMARIZE_BUDGET_CHARS,
    task: TASK(source),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
  })
  const text =
    answered.output.kind === 'text' ? answered.output.text.trim() : ''
  if (text === '')
    return yield* new SummarizeRefused({
      message: 'The model answered with an empty summary',
    })

  const labels = yield* citationLabels([...new Set(items.map((i) => i.ref))])
  const { markdown, cited } = inlineCitations(text, labels)
  const payload: NotePayload = {
    title: `Summary: ${source.name}`.slice(0, 300),
    markdown,
    sourceId: source.id,
  }
  return yield* proposeProgram({
    entityId: record.id,
    kind: 'note',
    payload,
    rationale: [
      `Summarized ${source.what} on the synthesize lane, from ${String(items.length)} context item${items.length === 1 ? '' : 's'}; ${String(cited.length)} cited inline.`,
      `Accepting writes a shared note filed against ${record.name}, derived from ${source.name}.`,
    ].join('\n'),
    refs: cited,
    proposedBy: { type: 'user', id: input.userId },
  })
})

// ---------- trigger + status (the Summarize buttons' two server fns) ----------

/** One job per (record, source): the key pg-boss refuses a second press on. */
export const summarizeKey = (recordId: string, sourceId: string): string =>
  `${recordId}:${sourceId}`

export type SummarizeEnqueued =
  | { status: 'queued' }
  | { status: 'already-summarizing' }
  | { status: 'queue-unavailable' }

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

/**
 * Press Summarize: one job on an `exclusive` queue keyed on the record and
 * the source — the deck reader's trigger (SPA-90), for the same reasons: a
 * synthesize call over a diligence pack is a minute of a frontier model, and
 * no request should hold that; and pg-boss, not a table, refuses the second
 * press. The checks here are the cheap ones; the empty-context refusal needs
 * the assembler and is the job's.
 */
export const enqueueSummarizeProgram = Effect.fn('enqueueSummarize')(
  function* (input: {
    recordId: string
    documentId: string | null
    userId: string
  }): Effect.fn.Return<
    SummarizeEnqueued,
    SummarizeRefused | SummarizeQueryFailed
  > {
    const record = (yield* query(() =>
      db
        .select({ mergedIntoId: entity.mergedIntoId })
        .from(entity)
        .where(eq(entity.id, input.recordId)),
    )).at(0)
    if (!record || record.mergedIntoId !== null)
      return yield* new SummarizeRefused({ message: 'That record is gone' })
    if (input.documentId !== null) {
      const documentId = input.documentId
      const doc = (yield* query(() =>
        db
          .select({ status: document.extractionStatus })
          .from(document)
          .where(eq(document.entityId, documentId)),
      )).at(0)
      if (!doc)
        return yield* new SummarizeRefused({ message: 'That document is gone' })
      if (doc.status !== 'done')
        return yield* new SummarizeRefused({
          message: 'Only a document whose text is extracted can be summarized',
        })
    }
    const key = summarizeKey(input.recordId, input.documentId ?? input.recordId)
    const jobId = yield* query(() =>
      enqueue(
        QUEUES.summarize,
        {
          recordId: input.recordId,
          documentId: input.documentId,
          userId: input.userId,
        },
        { singletonKey: key },
      ),
    )
    if (jobId !== null) return { status: 'queued' }
    const jobs = yield* query(() => jobsByKey(QUEUES.summarize, key))
    return jobs !== null && jobs.some(inFlight)
      ? { status: 'already-summarizing' }
      : { status: 'queue-unavailable' }
  },
)

export type SummarizeStatus =
  | { state: 'idle' }
  | { state: 'summarizing' }
  | { state: 'done'; at: string }
  | { state: 'failed'; message: string; at: string }

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
function reasonOf(output: object | null): string | null {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** The latest job for one key, as a button reads it. */
export function summarizeStatusOf(
  jobs: ReadonlyArray<QueuedJob>,
): SummarizeStatus {
  const latest = [...jobs]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { state: 'idle' }
  if (inFlight(latest)) return { state: 'summarizing' }
  const at = latest.createdOn.toISOString()
  if (latest.state === 'completed') return { state: 'done', at }
  return {
    state: 'failed',
    message: reasonOf(latest.output) ?? 'Could not summarize',
    at,
  }
}

/** Where each source's latest summary on this record stands, by source id. */
export const summarizeStatusProgram = Effect.fn('summarizeStatus')(function* (
  recordId: string,
  sourceIds: ReadonlyArray<string>,
): Effect.fn.Return<Record<string, SummarizeStatus>, SummarizeQueryFailed> {
  const out: Record<string, SummarizeStatus> = {}
  for (const id of sourceIds) {
    const jobs = yield* query(() =>
      jobsByKey(QUEUES.summarize, summarizeKey(recordId, id)),
    )
    out[id] = jobs === null ? { state: 'idle' } : summarizeStatusOf(jobs)
  }
  return out
})
