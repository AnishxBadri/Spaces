import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import { aiRun } from '@spaces/db/schema'
import type { AiRunStep } from '@spaces/db/schema'
import type { Caller } from './complete'
import type { AiLane } from './lanes'

/**
 * The run log's one writer. A run is one logical AI action ("Read deck") and
 * its ordered steps, one per lane call. Each program is a single row write:
 * - `openRunProgram` inserts at `running`; its id is threaded into every
 *   `complete()` (`ai_usage.run_id`) and `propose()` (`suggestion.run_id`).
 * - `addStepProgram` appends a step and rolls its tokens into the totals.
 * - `closeRunProgram` settles a `running` row. A process that dies first
 *   leaves it `running`; nothing here guesses that it failed.
 */

/** A run-log write that did not land. The action fails rather than go unrecorded. */
export class RunWriteFailed extends Schema.TaggedError<RunWriteFailed>()(
  'RunWriteFailed',
  { cause: Schema.Defect() },
) {}

export type OpenRun = {
  /** What the Usage page lists the run as: "Read deck", "Summarize". */
  task: string
  /** The record the action is about. */
  entityId: string | null
  startedBy: Caller
}

export type RunStepInput = {
  tool: AiLane
  inputRefs: ReadonlyArray<string>
  outputRef: string | null
  jobRunId: string | null
  /** The extraction cache answered: no call was made, no usage recorded. */
  cached?: boolean
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  /** The key the call resolved; the run keeps the first one it sees. */
  credentialId: string | null
}

/** What any lane call answered, as far as a step needs to know. */
type Answered = {
  target: { model: string }
  usage: { tokensIn: number | null; tokensOut: number | null }
  credentialId: string | null
  /** Set by the extraction cache on a hit. */
  cachedAt?: string | null
}

/**
 * One step from one call's answer: the model it reached, what it reported,
 * and — for an extraction-cache hit — `cached`, with no tokens.
 */
export function callStep(
  tool: AiLane,
  inputRefs: ReadonlyArray<string>,
  answered: Answered,
  outputRef: string | null,
  jobRunId: string | undefined,
): RunStepInput {
  const cached = answered.cachedAt !== undefined && answered.cachedAt !== null
  return {
    tool,
    inputRefs: [...new Set(inputRefs)],
    outputRef,
    jobRunId: jobRunId ?? null,
    ...(cached ? { cached: true } : {}),
    model: answered.target.model,
    tokensIn: answered.usage.tokensIn,
    tokensOut: answered.usage.tokensOut,
    credentialId: answered.credentialId,
  }
}

/** A step's output when it proposed: the suggestion it wrote. */
export const suggestionOutputRef = (id: string): string => `suggestion:${id}`

/** The inverse, for the Usage page; null for any other output. */
export function suggestionOfOutputRef(outputRef: string): string | null {
  return outputRef.startsWith('suggestion:')
    ? outputRef.slice('suggestion:'.length)
    : null
}

const write = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RunWriteFailed({ cause }),
  })

export const openRunProgram = Effect.fn('openRun')(function* (
  open: OpenRun,
): Effect.fn.Return<string, RunWriteFailed> {
  const row = (yield* write(() =>
    db
      .insert(aiRun)
      .values({
        task: open.task,
        entityId: open.entityId,
        startedByType: open.startedBy.type,
        startedById:
          open.startedBy.type === 'system' ? null : open.startedBy.id,
      })
      .returning({ id: aiRun.id }),
  )).at(0)
  if (!row)
    return yield* new RunWriteFailed({ cause: 'ai_run insert returned no row' })
  return row.id
})

/** Tokens add up; a step that reported none leaves the total as it was. */
const plus = (column: AnyPgColumn, n: number | null) =>
  n === null ? sql`${column}` : sql`coalesce(${column}, 0) + ${n}`

export const addStepProgram = Effect.fn('addStep')(function* (
  runId: string,
  input: RunStepInput,
): Effect.fn.Return<void, RunWriteFailed> {
  const step: AiRunStep = {
    tool: input.tool,
    input_refs: input.inputRefs,
    output_ref: input.outputRef,
    job_run_id: input.jobRunId,
    at: new Date().toISOString(),
    ...(input.cached === true ? { cached: true } : {}),
    model: input.model,
    tokens_in: input.tokensIn,
    tokens_out: input.tokensOut,
  }
  yield* write(() =>
    db
      .update(aiRun)
      .set({
        steps: sql`${aiRun.steps} || jsonb_build_array(${JSON.stringify(step)}::jsonb)`,
        tokensIn: plus(aiRun.tokensIn, input.tokensIn),
        tokensOut: plus(aiRun.tokensOut, input.tokensOut),
        credentialId:
          input.credentialId === null
            ? aiRun.credentialId
            : sql`coalesce(${aiRun.credentialId}, ${input.credentialId}::uuid)`,
      })
      .where(eq(aiRun.id, runId)),
  )
})

export type RunOutcome =
  { status: 'done' } | { status: 'failed'; error: string }

/** Settles a `running` run; a run already settled is left as it is. */
export const closeRunProgram = Effect.fn('closeRun')(function* (
  runId: string,
  outcome: RunOutcome,
): Effect.fn.Return<void, RunWriteFailed> {
  yield* write(() =>
    db
      .update(aiRun)
      .set({
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        finishedAt: new Date(),
      })
      .where(and(eq(aiRun.id, runId), eq(aiRun.status, 'running'))),
  )
})

/** What a feature's body sees of its run. */
export type RunScope = {
  /** The run's id — opening it now, on first use, when this scope owns it. */
  readonly id: Effect.Effect<string, RunWriteFailed>
  readonly step: (input: RunStepInput) => Effect.Effect<void, RunWriteFailed>
}

/**
 * Run `body` inside a run. `given` is a run somebody else opened and will
 * close (a step of a chain): the body only threads it. Absent, this scope
 * owns the run — opened lazily through `scope.id`, closed `done` when the body
 * succeeds and `failed` with `message(failure)` when it fails. A close that
 * does not land is logged, never raised: the action's own outcome stands,
 * and the row is left `running`, which is what it would show had the
 * process died there.
 */
export function withRun<TValue, TError, TServices>(
  given: string | undefined,
  open: OpenRun,
  body: (
    run: RunScope,
  ) => Effect.Effect<TValue, TError | RunWriteFailed, TServices>,
  message: (failure: TError | RunWriteFailed) => string,
): Effect.Effect<TValue, TError | RunWriteFailed, TServices> {
  return Effect.suspend(() => {
    const held: { id: string | null } = { id: given ?? null }
    const id: Effect.Effect<string, RunWriteFailed> = Effect.suspend(() =>
      held.id !== null
        ? Effect.succeed(held.id)
        : openRunProgram(open).pipe(
            Effect.tap((opened) =>
              Effect.sync(() => {
                held.id = opened
              }),
            ),
          ),
    )
    const scope: RunScope = {
      id,
      step: (input) =>
        id.pipe(Effect.flatMap((runId) => addStepProgram(runId, input))),
    }
    if (given !== undefined) return body(scope)
    const close = (outcome: RunOutcome) =>
      held.id === null
        ? Effect.void
        : closeRunProgram(held.id, outcome).pipe(
            Effect.catch((failure) =>
              Effect.logWarning('ai_run close failed', failure.cause),
            ),
          )
    return body(scope).pipe(
      Effect.matchEffect({
        onSuccess: (a) => close({ status: 'done' }).pipe(Effect.as(a)),
        onFailure: (failure) =>
          close({ status: 'failed', error: message(failure) }).pipe(
            Effect.andThen(Effect.fail(failure)),
          ),
      }),
    )
  })
}
