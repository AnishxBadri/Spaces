import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { document, documentKind, entity, suggestion } from '@spaces/db/schema'
import { DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import type { DocumentKindPayload } from '@spaces/core/ai/document-kind'
import { JSON_SCHEMA_DRAFT } from '@spaces/core/ai/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import { ref } from '#/lib/context/ref'
import { completeMessage, completeProgram } from './complete'
import type { CompleteFailure } from './complete'
import { proposeProgram, suggestionMessage } from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * Kind classify (SPA-62; docs/spec-ai-substrate.md §11's first row, §14
 * step 5) — the cheapest lane: a document whose kind is still `other` once
 * its text is extracted becomes at most one `suggestion(kind:
 * 'document_kind')` on the document itself. Never a value: accepting it is
 * what writes `document.kind` (`acceptProgram`).
 *
 * The options are the schema's, not a list written here: drizzle's
 * `documentKind.enumValues` minus `other` — "unknown" is never proposed.
 * An answer outside them (a model that ignored the enum, a kind the schema
 * has since dropped) is dropped and named in the rationale; when nothing is
 * left, no suggestion is written and the run ends without raising.
 *
 * It never competes with the deterministic guessers: a document that
 * arrived carrying a kind — from its filename (`guessDocumentKind`) or a
 * bound folder — is not `other`, and is skipped here as well as at the
 * enqueue (`onDocumentExtracted`). And it never chains: accepting a `deck`
 * writes the kind and the Read deck button appears; a person presses it.
 *
 * One classification per document, ever: a `document_kind` suggestion that
 * exists in any status — open, accepted or rejected — is the answer, and a
 * re-extraction does not ask again. A rejection is a negative assertion the
 * person made once, as a dismissed duplicate pair is.
 */

/** The head of the extracted text the model reads. A kind is on page one. */
export const CLASSIFY_HEAD_CHARS = 4_000
export const CLASSIFY_BUDGET_CHARS = 6_000

type SchemaKind = (typeof documentKind.enumValues)[number]
type ClassifiableKind = Exclude<SchemaKind, 'other'>

const classifiable = (k: SchemaKind): k is ClassifiableKind => k !== 'other'

/** What the model may answer: the schema's kinds, `other` removed. */
export const CLASSIFY_OPTIONS: ReadonlyArray<ClassifiableKind> =
  documentKind.enumValues.filter(classifiable)

const isOption = (k: string): k is ClassifiableKind =>
  CLASSIFY_OPTIONS.some((o) => o === k)

export class ClassifyQueryFailed extends Schema.TaggedError<ClassifyQueryFailed>()(
  'ClassifyQueryFailed',
  { cause: Schema.Defect() },
) {}

export type ClassifyFailure =
  | ClassifyQueryFailed
  | CompleteFailure
  | SuggestionFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ClassifyQueryFailed({ cause }),
  })

/** The sentence a failed run leaves on its job. */
export function classifyMessage(failure: ClassifyFailure): string {
  switch (failure._tag) {
    case 'ClassifyQueryFailed':
      return 'Could not read the document'
    case 'SensitivityReadFailed':
      return 'Could not read the document’s sensitivity'
    case 'SensitivityEntityNotFound':
      return 'That document is gone'
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

export type ClassifyInput = {
  documentId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  jobRunId?: string
}

export type ClassifyResult =
  | { status: 'proposed'; suggestion: Suggestion }
  | { status: 'skipped'; reason: string }

/** The answer's shape, read leniently: the options are checked after. */
const answerSchema = z.object({
  kinds: z.array(
    z.object({
      kind: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  reason: z.string().optional(),
})

function outputSchema(): JsonSchema {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    title: 'document kind',
    type: 'object',
    properties: {
      kinds: {
        type: 'array',
        description: 'Most likely first; one to three.',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...CLASSIFY_OPTIONS] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['kind', 'confidence'],
          additionalProperties: false,
        },
      },
      reason: {
        type: 'string',
        description: 'One sentence: what in the text gave it away.',
      },
    },
    required: ['kinds', 'reason'],
    additionalProperties: false,
  }
}

const TASK = (filename: string) =>
  [
    `Classify the document "${filename}" above by what kind of document it is.`,
    `Choose from: ${CLASSIFY_OPTIONS.map((k) => `${k} (${DOCUMENT_KIND_LABELS[k]})`).join(', ')}.`,
    'List one to three kinds, most likely first, each with a confidence between 0 and 1, and give a one-sentence reason.',
  ].join('\n')

export const classifyDocumentProgram = Effect.fn('classifyDocument')(function* (
  input: ClassifyInput,
): Effect.fn.Return<ClassifyResult, ClassifyFailure> {
  const { documentId } = input
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
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (!doc) return { status: 'skipped', reason: 'That document is gone' }
  if (doc.kind !== 'other')
    return {
      status: 'skipped',
      reason: `Already kinded ${doc.kind}; only a document at other is classified`,
    }
  const head = doc.text?.trim().slice(0, CLASSIFY_HEAD_CHARS) ?? ''
  if (doc.status !== 'done' || head === '')
    return { status: 'skipped', reason: 'The document has no extracted text' }

  const asked = yield* query(() =>
    db
      .select({ status: suggestion.status })
      .from(suggestion)
      .where(
        and(
          eq(suggestion.entityId, documentId),
          eq(suggestion.kind, 'document_kind'),
        ),
      )
      .limit(1),
  )
  const prior = asked.at(0)
  if (prior)
    return {
      status: 'skipped',
      reason: `Already classified once (${prior.status}); never proposed twice`,
    }

  const filename = doc.filename ?? doc.name
  const sensitivity = yield* sensitivityFor(documentId)
  const answered = yield* completeProgram(
    'classify',
    [
      {
        ref: ref.doc(documentId, 0),
        kind: 'doc_chunk',
        text: `${filename}: ${head}`,
        entityIds: [documentId],
        at: doc.createdAt.toISOString(),
      },
    ],
    outputSchema(),
    {
      // Nobody pressed anything: the lane runs off the extraction, as the
      // workspace, on the workspace's key.
      caller: { type: 'system' },
      sensitivity: sensitivity.sensitivity,
      ...(sensitivity.sensitivity === 'sensitive'
        ? { via: sensitivity.via }
        : {}),
      budgetChars: CLASSIFY_BUDGET_CHARS,
      task: TASK(filename),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
    },
  )

  const parsed = answerSchema.safeParse(
    answered.output.kind === 'object' ? answered.output.object : undefined,
  )
  const answers = parsed.success ? parsed.data.kinds : []
  const dropped: Array<string> = []
  let pick: DocumentKindPayload | null = null
  for (const a of answers) {
    if (!isOption(a.kind)) {
      dropped.push(a.kind)
      continue
    }
    pick ??=
      a.confidence === undefined
        ? { kind: a.kind }
        : { kind: a.kind, confidence: a.confidence }
  }
  const droppedLine =
    dropped.length === 0
      ? null
      : `Dropped ${dropped.map((d) => JSON.stringify(d)).join(', ')}: not one of ${CLASSIFY_OPTIONS.join(', ')}.`

  if (pick === null)
    return {
      status: 'skipped',
      reason: [
        parsed.success
          ? 'The model named no kind it may propose'
          : 'The model answered in no shape a kind can be read from',
        droppedLine,
      ]
        .filter((l) => l !== null)
        .join('. '),
    }

  const reason = parsed.success ? parsed.data.reason?.trim() : undefined
  const rationale = [
    `Read from the first ${String(head.length)} characters of ${filename}: this looks like ${articled(DOCUMENT_KIND_LABELS[pick.kind])}.`,
    reason === undefined || reason === '' ? null : reason,
    droppedLine,
    'Accepting sets the document’s kind; nothing else runs.',
  ]
    .filter((l) => l !== null)
    .join('\n')

  const proposed = yield* proposeProgram({
    entityId: documentId,
    kind: 'document_kind',
    payload: pick,
    rationale,
    refs: [ref.doc(documentId, 0)],
    proposedBy: { type: 'system' },
  })
  return { status: 'proposed', suggestion: proposed }
})

/** "a cap table", "an article" — the label, lowercased, with its article. */
function articled(label: string): string {
  const word = label.toLowerCase()
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`
}
