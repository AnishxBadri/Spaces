import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { readDeckMessage, readDeckProgram } from './read-deck'
import type { ReadDeckResult } from './read-deck'
import { withRun } from './run'
import type { RunWriteFailed } from './run'
import { summarizeMessage, summarizeProgram } from './summarize'
import type { Suggestion } from '@spaces/core/writes/suggestions/propose'

/**
 * Read deck and summarize: one press opens one `ai_run` with two steps,
 * **extract** (`readDeckProgram`, through the extraction cache) then
 * **synthesize** (Summarize onto the record it was pressed on).
 *
 * - Both get the run's id, so every `ai_usage` row and suggestion carries it.
 * - The summary never reads step 1's suggestions: they are not yet true and
 *   never enter a prompt.
 * - A failed step fails the run with its own sentence and stops; what an
 *   earlier step proposed stays in the inbox.
 */

/**
 * A step of the chain failed; `message` is that step's own sentence. `start`
 * is the chain's own check, before the run opens: the record the summary
 * would land on is gone.
 */
export class ReadDeckSummarizeFailed extends Schema.TaggedError<ReadDeckSummarizeFailed>()(
  'ReadDeckSummarizeFailed',
  {
    step: Schema.Literals(['start', 'extract', 'synthesize']),
    message: Schema.String,
  },
) {}

export type ReadDeckSummarizeFailure = ReadDeckSummarizeFailed | RunWriteFailed

export function readDeckSummarizeMessage(
  failure: ReadDeckSummarizeFailure,
): string {
  return failure._tag === 'RunWriteFailed'
    ? 'Could not record the AI run'
    : failure.message
}

export type ReadDeckSummarizeInput = {
  documentId: string
  /** The record whose Files tab it was pressed on — where the summary sits. */
  recordId: string
  userId: string
  /** The test seams: one injected model per lane. */
  extractModel?: LanguageModel
  synthesizeModel?: LanguageModel
  /** ISO 8601; defaults to now. */
  asOf?: string
  jobRunId?: string
}

export type ReadDeckSummarizeResult = {
  runId: string
  read: ReadDeckResult
  summary: Suggestion
}

export const readDeckSummarizeProgram = Effect.fn('readDeckSummarize')(
  function* (
    input: ReadDeckSummarizeInput,
  ): Effect.fn.Return<ReadDeckSummarizeResult, ReadDeckSummarizeFailure> {
    const shared = {
      documentId: input.documentId,
      userId: input.userId,
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
    }
    return yield* withRun(
      undefined,
      {
        task: 'Read deck and summarize',
        entityId: input.recordId,
        startedBy: { type: 'user', id: input.userId },
      },
      (run) =>
        Effect.gen(function* () {
          // The run names this record: a record that is gone refuses before
          // the run is opened against it.
          const record = yield* Effect.tryPromise({
            try: () =>
              db
                .select({ mergedIntoId: entity.mergedIntoId })
                .from(entity)
                .where(eq(entity.id, input.recordId)),
            catch: () =>
              new ReadDeckSummarizeFailed({
                step: 'start',
                message: 'Could not read the record',
              }),
          }).pipe(Effect.map((rows) => rows.at(0)))
          if (record === undefined || record.mergedIntoId !== null)
            return yield* new ReadDeckSummarizeFailed({
              step: 'start',
              message: 'That record is gone',
            })
          const runId = yield* run.id
          const read = yield* readDeckProgram({
            ...shared,
            runId,
            ...(input.extractModel === undefined
              ? {}
              : { model: input.extractModel }),
          }).pipe(
            Effect.mapError(
              (failure) =>
                new ReadDeckSummarizeFailed({
                  step: 'extract',
                  message: readDeckMessage(failure),
                }),
            ),
          )
          const summary = yield* summarizeProgram({
            ...shared,
            recordId: input.recordId,
            runId,
            ...(input.synthesizeModel === undefined
              ? {}
              : { model: input.synthesizeModel }),
          }).pipe(
            Effect.mapError(
              (failure) =>
                new ReadDeckSummarizeFailed({
                  step: 'synthesize',
                  message: summarizeMessage(failure),
                }),
            ),
          )
          return { runId, read, summary }
        }),
      readDeckSummarizeMessage,
    )
  },
)
