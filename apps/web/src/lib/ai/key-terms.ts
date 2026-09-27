import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { document, entity, link } from '@spaces/db/schema'
import {
  isKeyTermKind,
  keyTermsMarkdown,
  keyTermsSchema,
  readKeyTerms,
} from '@spaces/core/ai/key-terms'
import type { KeyTermKind, KeyTermRow } from '@spaces/core/ai/key-terms'
import type { NotePayload } from '@spaces/core/ai/note'
import { DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { completeMessage } from './complete'
import type { CompleteFailure } from './complete'
import { cachedExtractProgram } from './extraction-cache'
import { proposeProgram, suggestionMessage } from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
import { callStep, suggestionOutputRef, withRun } from './run'
import type { RunScope } from './run'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'
import type { SensitivityVia } from './sensitivity'
import { citationLabels, documentItems } from './summarize'

/**
 * Key terms (SPA-91; docs/spec-ai-substrate.md §11's `dd / legal` row, §14
 * step 5). A document of kind `legal` or `dd` filed on a deal is read on the
 * extract lane against a **hand-written** per-kind schema
 * (`@spaces/core/ai/key-terms`, which says why it is not compiled from the
 * registry), and what it states lands as one `suggestion(kind: 'note')` on
 * the deal — the note's body a term / value / citation table. It is the
 * extract that proves not every extract is an attribute patch: nothing here
 * writes a value, and the accept path is the summary's (`acceptProgram` →
 * `lib/notes/from-suggestion.ts`), which renders the table into a BlockNote
 * `table` block (`lib/notes/markdown-blocks.ts`).
 *
 * 1. **The deal.** The document's filing — its `tagged_in` links — must
 *    reach a deal, or the run refuses before any model call: the terms have
 *    nowhere to belong. A document filed on two deals is read once and
 *    proposed on each, since each is where the terms are looked for.
 * 2. **The context** is the document's own text, page-labelled
 *    (`documentItems`), and nothing else: the terms are what this document
 *    says, and a record's memos would only give the model somewhere else to
 *    read them from. It also keeps the extraction cache honest — the answer
 *    is a function of the bytes and the schema, whichever deal asks.
 * 3. **Sensitivity** is read live for the document and every deal; any one
 *    sensitive makes the call sensitive.
 * 4. **The call** goes through `cachedExtractProgram` under
 *    `key-terms/<kind>/v1`, so a re-press over the same bytes is answered
 *    from disk with no provider call.
 * 5. **The answer** is held to the schema again (`readKeyTerms`): a term the
 *    document does not state is absent — never a row saying "not found" —
 *    and a term whose every ref is one the context did not carry is dropped,
 *    so every row of the table carries a citation. The citation is written
 *    as words ("term sheet.pdf, p.2") by the summary's own labeller, because
 *    the note outlives the suggestion row that holds the refs.
 */

export const KEY_TERMS_BUDGET_CHARS = 48_000

/** The extraction cache's purpose. Bump the version when the task changes. */
export const keyTermsPurpose = (kind: KeyTermKind): string =>
  `key-terms/${kind}/v1`

export class KeyTermsRefused extends Schema.TaggedError<KeyTermsRefused>()(
  'KeyTermsRefused',
  { message: Schema.String },
) {}

export class KeyTermsQueryFailed extends Schema.TaggedError<KeyTermsQueryFailed>()(
  'KeyTermsQueryFailed',
  { cause: Schema.Defect() },
) {}

export type KeyTermsFailure =
  | KeyTermsRefused
  | KeyTermsQueryFailed
  | CompleteFailure
  | SuggestionFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new KeyTermsQueryFailed({ cause }),
  })

/** The refusal a document with no deal in its filing gets. */
export const NO_DEAL =
  'The document is not filed on a deal, so its terms have nowhere to belong'

/**
 * The sentence a failed run leaves on its job — and so what the Files tab's
 * toast says. A provider that answered with an error keeps its own words.
 */
export function keyTermsMessage(failure: KeyTermsFailure): string {
  switch (failure._tag) {
    case 'KeyTermsRefused':
      return failure.message
    case 'KeyTermsQueryFailed':
      return 'Could not read the document'
    case 'SensitivityReadFailed':
      return 'Could not read the deal’s sensitivity'
    case 'SensitivityEntityNotFound':
      return 'The deal or the document no longer exists'
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

export type KeyTermsInput = {
  documentId: string
  /** Who pressed Extract key terms — `ai_usage.caller`, and the proposer. */
  userId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  jobRunId?: string
  /** A run this is a step of (SPA-100); absent, it opens its own. */
  runId?: string
}

export type KeyTermsResult = {
  /** One per deal the document is filed on. */
  suggestions: Array<Suggestion>
  /** How many terms the note lists. */
  terms: number
}

/** The deals a document is filed on: its `tagged_in` links, merges followed out. */
const dealsOf = (documentId: string) =>
  query(() =>
    db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(
          eq(link.fromEntityId, documentId),
          eq(link.relation, 'tagged_in'),
          eq(entity.kind, 'deal'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(entity.canonicalName)),
  )

/**
 * No deal is named: the answer is stored in the extraction cache under the
 * bytes and the schema, and must mean the same whichever deal pressed.
 */
const TASK = (kind: KeyTermKind, filename: string) =>
  [
    `Read the ${DOCUMENT_KIND_LABELS[kind].toLowerCase()} document "${filename}" above and fill in the key terms it states.`,
    'Write each term briefly, in the document’s own terms. Use only what the document states.',
    'Leave out every term the document does not state. Never write "not found", "N/A" or a guess.',
    'For each term, list in `refs` the bracketed refs of the context items it was read from, exactly as written above.',
  ].join('\n')

export const keyTermsProgram = Effect.fn('keyTerms')(function* (
  input: KeyTermsInput,
): Effect.fn.Return<KeyTermsResult, KeyTermsFailure> {
  return yield* withRun(
    input.runId,
    {
      task: 'Extract key terms',
      entityId: input.documentId,
      startedBy: { type: 'user', id: input.userId },
    },
    (run) => keyTermsInRun(input, run),
    keyTermsMessage,
  )
})

const keyTermsInRun = Effect.fn('keyTerms.inRun')(function* (
  input: KeyTermsInput,
  run: RunScope,
): Effect.fn.Return<KeyTermsResult, KeyTermsFailure> {
  const doc = (yield* query(() =>
    db
      .select({
        filename: document.filename,
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
    return yield* new KeyTermsRefused({ message: 'That document is gone' })
  const kind = doc.kind
  if (!isKeyTermKind(kind))
    return yield* new KeyTermsRefused({
      message: 'Only a legal or diligence document has key terms to extract',
    })
  if (doc.status !== 'done')
    return yield* new KeyTermsRefused({
      message: 'The document’s text is not extracted yet',
    })

  const deals = yield* dealsOf(input.documentId)
  if (deals.length === 0)
    return yield* new KeyTermsRefused({ message: NO_DEAL })

  const filename = doc.filename ?? doc.name
  const items = yield* documentItems(
    input.documentId,
    filename,
    doc.text,
    doc.createdAt.toISOString(),
  ).pipe(Effect.mapError((cause) => new KeyTermsQueryFailed({ cause })))
  if (items.length === 0)
    return yield* new KeyTermsRefused({ message: `${filename} has no text` })

  // The first sensitive read decides, and names why in any refusal.
  let via: SensitivityVia | null = null
  for (const id of [input.documentId, ...deals.map((d) => d.id)]) {
    const read = yield* sensitivityFor(id)
    if (read.sensitivity === 'sensitive') {
      via = read.via
      break
    }
  }

  const runId = yield* run.id
  const answered = yield* cachedExtractProgram(
    {
      blobSha: doc.blobSha,
      documentId: input.documentId,
      purpose: keyTermsPurpose(kind),
    },
    items,
    keyTermsSchema(kind),
    {
      caller: { type: 'user', id: input.userId },
      ...(via === null
        ? { sensitivity: 'normal' }
        : { sensitivity: 'sensitive', via }),
      budgetChars: KEY_TERMS_BUDGET_CHARS,
      task: TASK(kind, filename),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
      runId,
    },
  )
  const step = (outputRef: string | null) =>
    run.step(
      callStep(
        'extract',
        items.map((i) => i.ref),
        answered,
        outputRef,
        input.jobRunId,
      ),
    )
  const raw =
    answered.output.kind === 'object' ? answered.output.object : undefined
  const { terms, dropped } = readKeyTerms(kind, raw)

  // Every row cites something the model was shown: a ref the context did
  // not carry is dropped, and a term left citing nothing is not a row.
  const known = new Set(items.map((i) => i.ref))
  const cited = terms
    .map((t) => ({ ...t, refs: t.refs.filter((r) => known.has(r)) }))
    .filter((t) => t.refs.length > 0)
  const labels = yield* citationLabels([
    ...new Set(cited.flatMap((t) => t.refs)),
  ]).pipe(Effect.mapError((cause) => new KeyTermsQueryFailed({ cause })))
  const rows: Array<KeyTermRow & { refs: Array<string> }> = []
  for (const t of cited) {
    const words = [...new Set(t.refs.flatMap((r) => labels.get(r) ?? []))].join(
      '; ',
    )
    if (words !== '')
      rows.push({ term: t.term, value: t.value, citation: words, refs: t.refs })
  }
  if (rows.length === 0) {
    yield* step(null)
    return yield* new KeyTermsRefused({
      message: `No key terms found in ${filename}`,
    })
  }

  const payload: NotePayload = {
    title: `Key terms: ${filename}`.slice(0, 300),
    markdown: keyTermsMarkdown(rows),
    sourceId: input.documentId,
  }
  const refs = [...new Set(rows.flatMap((r) => r.refs))]
  const rationale = [
    `Read from ${filename} against the ${DOCUMENT_KIND_LABELS[kind].toLowerCase()} key terms: ${String(rows.length)} term${rows.length === 1 ? '' : 's'} stated, each with its citation.`,
    ...(answered.cachedAt === null
      ? []
      : [
          `Answered from the extraction cache (cached): ${answered.target.model} read these bytes at ${answered.cachedAt}, so no provider call was made and no usage was recorded.`,
        ]),
    ...(terms.length > rows.length
      ? [
          `${String(terms.length - rows.length)} term${terms.length - rows.length === 1 ? ' was' : 's were'} left out for citing nothing the document holds.`,
        ]
      : []),
    ...(dropped.length > 0
      ? [
          `Dropped at validation: ${dropped.join(', ')} — not a key term of this kind, or not a value with refs.`,
        ]
      : []),
    ...(deals.length > 1
      ? [
          `The document is filed on ${String(deals.length)} deals; the same terms are proposed on each.`,
        ]
      : []),
    'Accepting writes a shared note filed on the deal, derived from the document. Nothing is written to the deal’s fields.',
  ].join('\n')

  const suggestions: Array<Suggestion> = []
  for (const d of deals)
    suggestions.push(
      yield* proposeProgram({
        entityId: d.id,
        kind: 'note',
        payload,
        rationale,
        refs,
        runId,
        proposedBy: { type: 'user', id: input.userId },
      }),
    )
  const out = suggestions.at(0)
  yield* step(out === undefined ? null : suggestionOutputRef(out.id))
  return { suggestions, terms: rows.length }
})

// ---------- trigger + status (the Files tab's two server fns) ----------

export type KeyTermsEnqueued =
  | { status: 'queued' }
  | { status: 'already-extracting' }
  | { status: 'queue-unavailable' }

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

/**
 * Press Extract key terms: one job keyed on the document, on an `exclusive`
 * queue — the deck reader's trigger (SPA-90). The cheap checks are here, the
 * same the button's gate made in the browser (`offersKeyTerms`), so a stale
 * tab cannot queue a read that would only refuse.
 */
export const enqueueKeyTermsProgram = Effect.fn('enqueueKeyTerms')(function* (
  documentId: string,
  userId: string,
): Effect.fn.Return<KeyTermsEnqueued, KeyTermsRefused | KeyTermsQueryFailed> {
  const doc = (yield* query(() =>
    db
      .select({ kind: document.kind, status: document.extractionStatus })
      .from(document)
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (!doc)
    return yield* new KeyTermsRefused({ message: 'That document is gone' })
  if (!isKeyTermKind(doc.kind) || doc.status !== 'done')
    return yield* new KeyTermsRefused({
      message:
        'Only a legal or diligence document whose text is extracted has key terms',
    })
  const deals = yield* dealsOf(documentId)
  if (deals.length === 0)
    return yield* new KeyTermsRefused({ message: NO_DEAL })
  const jobId = yield* query(() =>
    enqueue(
      QUEUES.extractKeyTerms,
      { documentId, userId },
      { singletonKey: documentId },
    ),
  )
  if (jobId !== null) return { status: 'queued' }
  const jobs = yield* query(() => jobsByKey(QUEUES.extractKeyTerms, documentId))
  return jobs !== null && jobs.some(inFlight)
    ? { status: 'already-extracting' }
    : { status: 'queue-unavailable' }
})

export type KeyTermsStatus =
  | { state: 'idle' }
  | { state: 'extracting' }
  | { state: 'done'; at: string }
  | { state: 'failed'; message: string; at: string }

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
function reasonOf(output: object | null): string | null {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** The latest job for a document, as the button reads it. */
export function keyTermsStatusOf(
  jobs: ReadonlyArray<QueuedJob>,
): KeyTermsStatus {
  const latest = [...jobs]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { state: 'idle' }
  if (inFlight(latest)) return { state: 'extracting' }
  const at = latest.createdOn.toISOString()
  if (latest.state === 'completed') return { state: 'done', at }
  return {
    state: 'failed',
    message: reasonOf(latest.output) ?? 'Could not extract the key terms',
    at,
  }
}

export const keyTermsStatusProgram = Effect.fn('keyTermsStatus')(function* (
  documentIds: ReadonlyArray<string>,
): Effect.fn.Return<Record<string, KeyTermsStatus>, KeyTermsQueryFailed> {
  const out: Record<string, KeyTermsStatus> = {}
  for (const id of documentIds) {
    const jobs = yield* query(() => jobsByKey(QUEUES.extractKeyTerms, id))
    out[id] = jobs === null ? { state: 'idle' } : keyTermsStatusOf(jobs)
  }
  return out
})
