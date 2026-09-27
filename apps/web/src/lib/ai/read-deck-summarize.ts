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
import type { Suggestion } from './propose'

/**
 * Read deck and summarize (SPA-100; docs/spec-ai-substrate.md §6, §14 step
 * 10): the first **two-step run**. One press on a Files-tab deck opens one
 * `ai_run` and runs, in order, inside it:
 *
 *   1. **extract** — the deck reader (`./read-deck.ts`), through the
 *      extraction cache, so a deck already read against these fields is a
 *      `cached` step with no call and no `ai_usage` row;
 *   2. **synthesize** — Summarize (`./summarize.ts`) of the same deck onto
 *      the record whose Files tab it was pressed on.
 *
 * Both are handed the run's id, so they open no run of their own: every
 * `ai_usage` row either writes and every suggestion either proposes carries
 * it, and each adds its step in order. The steps are independent reads of
 * the deck — the summary never reads step 1's suggestions, which are not
 * yet true and never enter a prompt (spec §3).
 *
 * A failed step fails the run with that step's sentence — the provider's own
 * words when it answered with an error — and stops. What an earlier step
 * proposed stays in the inbox, open and cited: a suggestion is a row, and
 * the run failing after it does not unwrite it.
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
