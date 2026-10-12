import { Cause, Effect, Exit, Option } from 'effect'
import { tool } from 'ai'
import type { LanguageModel, ToolSet } from 'ai'
import { z } from 'zod'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { askThread, askTurn, entity, objectDef } from '@spaces/db/schema'
import { parseRef } from '@spaces/core/context/ref'
import { addStepProgram, closeRunProgram, openRunProgram } from '#/lib/ai/run'
import { completeMessage } from '#/lib/ai/complete'
import { isLocalProvider } from '#/lib/ai/route'
import type { AiTarget } from '#/lib/ai/route'
import { refusedLine, routeLine, providerLabel } from '#/lib/ai/route-line'
import type { SensitivityVia } from '#/lib/ai/sensitivity'
import { sensitivityFor } from '#/lib/ai/sensitivity-for'
import { openStreamProgram } from '#/lib/ai/stream'
import type { OpenedStream, StreamOpenFailure } from '#/lib/ai/stream'
import { citationLabels } from '#/lib/ai/summarize'
import { entityOfRef, toolRegistry } from '#/lib/mcp/registry'
import type { ToolCaller } from '#/lib/mcp/registry'
import { recordPath } from '#/lib/record-path'
import { citedRefs } from './answer'
import { storeCardsProgram } from './card-store'
import type { HeldCard } from './card-store'
import type { AskCardView } from './cards'
import {
  askQuery,
  ownThreadProgram,
  threadTurnsProgram,
  turnView,
  turnViewsProgram,
} from './threads'
import type {
  AskCall,
  AskEvent,
  AskRef,
  AskScopeChip,
  AskTurnState,
} from './types'

/**
 * One Ask turn: the agent loop over the MCP tool table, streamed. (D70)
 * - Tools are called through `toolRegistry.call`, the external MCP server's
 *   door, as the asker.
 * - The gate is per call and reads what was retrieved: the scope first,
 *   then every entity a tool answer reveals. A sensitive find on a cloud
 *   route stops the attempt before the model sees it and the turn starts
 *   again on the sensitive route — local, or refused.
 * - The turn is frozen as asked: scope, calls and cited sources with their
 *   labels are stored on the answer row however the stream ends.
 * - One `ai_run` per answer, under the daily cap.
 * - Action cards stream as proposed and are stored as open suggestions only
 *   with an answered turn; their evidence must be refs the turn retrieved.
 */

/** The whole prompt's ceiling, history and question included. */
export const ASK_BUDGET_CHARS = 40_000
/** Model steps a turn may take: tool calls, then the answer. */
export const ASK_MAX_STEPS = 6
/** Earlier turns the model is shown. */
const HISTORY_TURNS = 6

export type AskInput = {
  userId: string
  threadId: string | null
  question: string
  scope: ReadonlyArray<AskScopeChip>
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  abortSignal?: AbortSignal
}

type Begun = {
  threadId: string
  title: string
  questionId: string
  answerId: string
  runId: string
  history: string
}

const titleOf = (question: string): string => {
  const flat = question.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/**
 * The run, the thread (new or the asker's own) and both turn rows.
 * - The run opens before any row is written: a run that cannot be recorded
 *   leaves no question without an answer.
 */
const beginProgram = Effect.fn('ask.begin')(function* (input: AskInput) {
  const own =
    input.threadId === null
      ? null
      : yield* ownThreadProgram(input.userId, input.threadId)
  const scoped = input.scope.find((c) => c.id !== null)
  const runId = yield* openRunProgram({
    task: 'Ask',
    entityId: scoped?.id ?? null,
    startedBy: { type: 'user', id: input.userId },
  })
  return yield* writeTurnsProgram(input, own, runId).pipe(
    Effect.tapError(() =>
      closeRunProgram(runId, {
        status: 'failed',
        error: 'Could not record the question',
      }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  )
})

const writeTurnsProgram = Effect.fn('ask.writeTurns')(function* (
  input: AskInput,
  own: typeof askThread.$inferSelect | null,
  runId: string,
) {
  // Earlier answers the asker can still read, newest last.
  const earlier =
    own === null
      ? []
      : yield* turnViewsProgram(input.userId, yield* threadTurnsProgram(own.id))
  const history = earlier
    .filter((t) => !t.hidden && t.body.trim() !== '')
    .slice(-HISTORY_TURNS * 2)
    .map((t) =>
      t.role === 'user'
        ? `Reader: ${t.body}`
        : `You answered: ${t.body.slice(0, 2000)}`,
    )
    .join('\n\n')

  // A new thread and both turns in one transaction: never a thread or a
  // question without its answer row.
  const rows = yield* askQuery(() =>
    db.transaction(async (tx) => {
      const thread =
        own ??
        (
          await tx
            .insert(askThread)
            .values({ userId: input.userId, title: titleOf(input.question) })
            .returning()
        ).at(0)
      if (!thread) throw new Error('ask_thread insert returned no row')
      const question = (
        await tx
          .insert(askTurn)
          .values({
            threadId: thread.id,
            role: 'user',
            bodyMd: input.question,
            scope: [...input.scope],
          })
          .returning()
      ).at(0)
      const answer = (
        await tx
          .insert(askTurn)
          .values({
            threadId: thread.id,
            role: 'assistant',
            scope: [...input.scope],
            aiRunId: runId,
            state: 'streaming',
          })
          .returning({ id: askTurn.id })
      ).at(0)
      if (!question || !answer)
        throw new Error('ask_turn insert returned no row')
      return { thread, question, answer }
    }),
  )
  const begun: Begun = {
    threadId: rows.thread.id,
    title: rows.thread.title,
    questionId: rows.question.id,
    answerId: rows.answer.id,
    runId,
    history,
  }
  return { begun, question: turnView(rows.question, false) }
})

type Gate = { sensitive: boolean; via: SensitivityVia | null }

/** The first entity of `ids` that resolves sensitive, or none. */
const gateOf = Effect.fn('ask.gate')(function* (
  ids: ReadonlyArray<string>,
  known: Map<string, Gate>,
): Effect.fn.Return<Gate> {
  for (const id of ids) {
    let verdict = known.get(id)
    if (verdict === undefined) {
      const read = yield* sensitivityFor(id).pipe(Effect.result)
      verdict =
        read._tag === 'Success'
          ? read.success.sensitivity === 'sensitive'
            ? { sensitive: true, via: read.success.via }
            : { sensitive: false, via: null }
          : // A record gone mid-turn reveals nothing.
            { sensitive: false, via: null }
      known.set(id, verdict)
    }
    if (verdict.sensitive) return verdict
  }
  return { sensitive: false, via: null }
})

const TASK = (input: AskInput, history: string): string => {
  const scope = input.scope.filter((c) => c.id !== null)
  return [
    'You answer questions about the reader’s own deal-management workspace: companies, people, deals, notes, documents, spaces and the portfolio.',
    'Use the tools to look things up; never answer from memory. Counts, filters and money come from query_records and the portfolio tools, never from your own arithmetic over a sample.',
    scope.length === 0
      ? 'The reader is asking about the whole workspace.'
      : `The reader is asking about ${scope.map((c) => `${c.name} (${c.kind}, id ${c.id})`).join(' and ')}; start with get_context on it.`,
    'Cite every sentence that states a fact, right after it, in square brackets: a record as [record:<id>] with the id a tool returned, and a context item by the ref it carries, exactly as written — for example [note:<id>] or [doc:<id>#3]. Several refs share one bracket, separated by commas.',
    'A sentence you cannot cite does not belong in the answer. If nothing was found, say so in one line and name what you searched.',
    'Write markdown: short paragraphs, `- ` bullets, and a pipe table for a list of records. No title line, no code fence.',
    'When the reader would act on what you found — a follow-up, a stage move, a filing — offer it with propose_card, one card per action and record, citing the refs it rests on. You never apply a card; the reader does.',
    history === '' ? '' : `The conversation so far:\n\n${history}`,
    `Reader: ${input.question}`,
  ]
    .filter((line) => line !== '')
    .join('\n\n')
}

/** The cited refs the turn may stand behind, with their labels frozen. */
const freezeRefsProgram = Effect.fn('ask.freezeRefs')(function* (
  text: string,
  touched: ReadonlySet<string>,
  seen: ReadonlySet<string>,
) {
  const cited = citedRefs(text).filter((r) => {
    if (seen.has(r)) return true
    const id = r.startsWith('record:')
      ? r.slice('record:'.length)
      : entityOfRef(r)
    return (
      id !== null &&
      touched.has(id) &&
      (r.startsWith('record:') || parseRef(r) !== null)
    )
  })
  if (cited.length === 0) return []
  const records = cited.filter((r) => r.startsWith('record:'))
  const entityIds = [
    ...new Set(
      cited.flatMap((r) => {
        const id = r.startsWith('record:')
          ? r.slice('record:'.length)
          : entityOfRef(r)
        return id === null ? [] : [id]
      }),
    ),
  ]
  const rows =
    entityIds.length === 0
      ? []
      : yield* askQuery(() =>
          db
            .select({
              id: entity.id,
              kind: entity.kind,
              name: entity.canonicalName,
              objectSlug: objectDef.slug,
            })
            .from(entity)
            .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
            .where(inArray(entity.id, entityIds)),
        )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const labels = yield* citationLabels(
    cited.filter((r) => !r.startsWith('record:')),
  ).pipe(Effect.orElseSucceed(() => new Map<string, string>()))
  const out: Array<AskRef> = []
  for (const r of cited) {
    const id = r.startsWith('record:')
      ? r.slice('record:'.length)
      : entityOfRef(r)
    const row = id === null ? undefined : byId.get(id)
    const label = records.includes(r) ? row?.name : labels.get(r)
    if (label === undefined) continue
    out.push({
      ref: r,
      label,
      href:
        row === undefined || parseRef(r)?.kind === 'doc'
          ? null
          : recordPath(row),
      entityId: row?.id ?? null,
    })
  }
  return out
})

type Finish = {
  state: AskTurnState
  text: string
  route: string | null
  calls: ReadonlyArray<AskCall>
  refs: ReadonlyArray<AskRef>
}

const finishProgram = Effect.fn('ask.finish')(function* (
  begun: Begun,
  finish: Finish,
  step: {
    target: AiTarget
    tokensIn: number | null
    tokensOut: number | null
  } | null,
) {
  const row = (yield* askQuery(() =>
    db
      .update(askTurn)
      .set({
        state: finish.state,
        bodyMd: finish.text,
        route: finish.route,
        calls: [...finish.calls],
        refs: [...finish.refs],
      })
      .where(eq(askTurn.id, begun.answerId))
      .returning(),
  )).at(0)
  if (step !== null)
    yield* addStepProgram(begun.runId, {
      tool: 'synthesize',
      inputRefs: finish.refs.map((r) => r.ref),
      outputRef: null,
      jobRunId: null,
      model: step.target.model,
      tokensIn: step.tokensIn,
      tokensOut: step.tokensOut,
      credentialId: null,
    }).pipe(Effect.orElseSucceed(() => undefined))
  const failed = ['failed', 'capped', 'refused', 'no_provider'].includes(
    finish.state,
  )
  yield* closeRunProgram(
    begun.runId,
    failed
      ? { status: 'failed', error: finish.route ?? finish.state }
      : { status: 'done' },
  ).pipe(Effect.orElseSucceed(() => undefined))
  return row
})

/** Why an attempt could not open, as the turn's state and line. */
function openFailure(
  f: StreamOpenFailure,
  sensitive: boolean,
): { state: AskTurnState; line: string } {
  switch (f._tag) {
    case 'CapExceeded':
      return { state: 'capped', line: completeMessage(f) }
    case 'SensitiveRouteRefused':
      return { state: 'refused', line: refusedLine(completeMessage(f)) }
    case 'LaneNotRouted':
    case 'NoCredential':
      return sensitive
        ? {
            state: 'refused',
            line: refusedLine(
              'Sensitive material needs a local model, and none is routed',
            ),
          }
        : { state: 'no_provider', line: 'Ask needs a model to answer' }
    default:
      return { state: 'failed', line: completeMessage(f) }
  }
}

/** Raised inside a tool when a cloud attempt finds something sensitive. */
class Escalate extends Error {}

/** A tool failure's sentence, as the model is handed it. */
const failureSentence = (cause: Cause.Cause<{ message: string }>): string => {
  const failure = Cause.findErrorOption(cause)
  return Option.isSome(failure) && failure.value.message
    ? failure.value.message
    : 'The tool failed'
}

/** What one attempt left behind, written from inside the tool callbacks. */
type Attempt = {
  target: AiTarget | null
  escalateTo: Gate | null
  /** Cards proposed in this attempt, by tool call; an escalation drops them. */
  cards: Map<string, HeldCard>
}

/** A held card as the stream shows it, before it is stored. */
const proposedView = (held: HeldCard): AskCardView => ({
  id: held.callId,
  kind: held.draft.kind,
  record: held.draft.record,
  summary: held.draft.summary,
  rationale: held.draft.rationale,
  evidence: held.evidence,
  outcome: 'proposed',
  moved: false,
})

/** A turn as events: the rows, the route, calls and text, then the stored turn. */
export async function* askEvents(input: AskInput): AsyncGenerator<AskEvent> {
  const started = await Effect.runPromise(beginProgram(input))
  const { begun } = started
  yield {
    type: 'turn',
    threadId: begun.threadId,
    title: begun.title,
    question: started.question,
    answerId: begun.answerId,
  }

  const known = new Map<string, Gate>()
  const scopeIds = input.scope.flatMap((c) => (c.id === null ? [] : [c.id]))
  let gate = await Effect.runPromise(gateOf(scopeIds, known))
  const calls = new Map<string, AskCall>()
  const touched = new Set<string>()
  const seen = new Set<string>()
  let text = ''
  let route: string | null = null
  let finished: Finish | null = null
  let opened: OpenedStream | null = null
  let lastTarget: AiTarget | null = null
  let cards = new Map<string, HeldCard>()
  // False while the reader may still cancel mid-stream; a cancelled reader
  // reads nothing more, so the stored turn is not yielded to it.
  let reachedEnd = false

  const caller: ToolCaller = {
    userId: input.userId,
    proposer: { kind: 'ask', runId: begun.runId },
  }

  try {
    for (let n = 0; n < 2 && finished === null; n++) {
      const own = new AbortController()
      const signal =
        input.abortSignal === undefined
          ? own.signal
          : AbortSignal.any([input.abortSignal, own.signal])
      const attempt: Attempt = {
        target: null,
        escalateTo: null,
        cards: new Map(),
      }
      cards = attempt.cards
      const announced = new Set<string>()

      const tools: ToolSet = {}
      for (const t of toolRegistry.askTools)
        tools[t.name] = tool({
          description: t.description,
          inputSchema: z.object(t.inputSchema),
          execute: async (raw, { toolCallId }) => {
            const exit = await Effect.runPromiseExit(
              toolRegistry.call(t.name, caller, raw),
            )
            if (Exit.isFailure(exit)) {
              calls.set(toolCallId, {
                tool: t.name,
                state: 'refused',
                input: '',
                found: null,
              })
              return { error: failureSentence(exit.cause) }
            }
            const answer = exit.value
            const verdict = await Effect.runPromise(
              gateOf(answer.touches, known),
            )
            if (verdict.sensitive && !gate.sensitive) {
              const local =
                attempt.target !== null &&
                isLocalProvider(attempt.target.provider)
              if (!local) {
                // The cloud model never sees this answer.
                attempt.escalateTo = verdict
                calls.set(toolCallId, {
                  tool: t.name,
                  state: 'refused',
                  input: answer.input,
                  found: answer.found,
                })
                own.abort()
                throw new Escalate()
              }
              gate = verdict
            }
            if (answer.card !== null) {
              // Evidence is what the turn retrieved before this call: the
              // card's own record is not its proof.
              const evidence = await Effect.runPromise(
                freezeRefsProgram(
                  `[${answer.card.refs.join(', ')}]`,
                  touched,
                  seen,
                ).pipe(Effect.orElseSucceed((): Array<AskRef> => [])),
              )
              if (evidence.length === 0) {
                calls.set(toolCallId, {
                  tool: t.name,
                  state: 'refused',
                  input: answer.input,
                  found: null,
                })
                return {
                  error:
                    'A card needs evidence: cite refs or record ids this turn retrieved',
                }
              }
              attempt.cards.set(toolCallId, {
                callId: toolCallId,
                draft: answer.card,
                evidence,
              })
            }
            // A proposal's target is not something the turn read.
            if (!answer.proposal)
              for (const id of answer.touches) touched.add(id)
            for (const r of answer.refs) seen.add(r)
            calls.set(toolCallId, {
              tool: t.name,
              state: 'done',
              input: answer.input,
              found: answer.found,
            })
            return answer.value
          },
        })

      const ready = await Effect.runPromise(
        Effect.result(
          openStreamProgram('synthesize', [], {
            caller: { type: 'user', id: input.userId },
            sensitivity: gate.sensitive ? 'sensitive' : 'normal',
            ...(gate.via === null ? {} : { via: gate.via }),
            budgetChars: ASK_BUDGET_CHARS,
            task: TASK(input, begun.history),
            runId: begun.runId,
            tools,
            maxSteps: ASK_MAX_STEPS,
            abortSignal: signal,
            ...(input.model === undefined ? {} : { model: input.model }),
          }),
        ),
      )
      if (ready._tag === 'Failure') {
        const f = openFailure(ready.failure, gate.sensitive)
        route = f.line
        finished = {
          state: f.state,
          text: '',
          route,
          calls: [...calls.values()],
          refs: [],
        }
        break
      }
      const stream = ready.success
      opened = stream
      attempt.target = stream.target
      lastTarget = stream.target
      text = ''
      route = routeLine(stream.target, gate.via, gate.sensitive)
      yield { type: 'route', line: route, sensitive: gate.sensitive }

      let providerFailed = false
      try {
        for await (const part of stream.parts) {
          if (part.type === 'text') {
            text += part.text
            yield { type: 'text', text: part.text }
            continue
          }
          // The SDK runs a tool at step end, apart from this reader: by the
          // time a part is read here, `execute` may already have settled the
          // call. A settled entry is never overwritten by an earlier part.
          const held = calls.get(part.toolCallId)
          const call: AskCall =
            part.type === 'tool-call'
              ? (held ?? {
                  tool: part.toolName,
                  state: 'running',
                  input: '',
                  found: null,
                })
              : held === undefined
                ? {
                    tool: part.toolName,
                    state: part.type === 'tool-error' ? 'failed' : 'done',
                    input: '',
                    found: null,
                  }
                : held.state === 'running'
                  ? {
                      ...held,
                      state: part.type === 'tool-error' ? 'failed' : 'done',
                    }
                  : held
          calls.set(part.toolCallId, call)
          yield { type: 'call', id: part.toolCallId, call }
          const proposed = attempt.cards.get(part.toolCallId)
          if (proposed !== undefined && !announced.has(part.toolCallId)) {
            announced.add(part.toolCallId)
            yield { type: 'card', card: proposedView(proposed) }
          }
        }
      } catch {
        providerFailed = true
      }
      await stream.close()
      opened = null
      if (attempt.escalateTo !== null) {
        gate = attempt.escalateTo
        continue
      }
      if (input.abortSignal?.aborted) break
      const answerText = text.trim()
      const refs = await Effect.runPromise(
        freezeRefsProgram(answerText, touched, seen).pipe(
          Effect.orElseSucceed((): Array<AskRef> => []),
        ),
      )
      const retrieval = [...calls.values()].filter(
        (c) => c.tool !== 'list_registry',
      )
      const empty =
        refs.length === 0 &&
        retrieval.length > 0 &&
        retrieval.every((c) => c.found === 0)
      // A provider failure wins over "nothing found", so Retry is offered.
      const state: AskTurnState = providerFailed
        ? 'failed'
        : empty
          ? 'empty'
          : answerText === ''
            ? 'failed'
            : 'answered'
      // Cards stand only beside an answer: stored now, they are Review items.
      if (state === 'answered' && cards.size > 0) {
        const stored = await Effect.runPromise(
          storeCardsProgram(input.userId, begun.runId, [...cards.values()]),
        )
        for (const [callId, card] of stored.cards) {
          const call = calls.get(callId)
          if (call !== undefined) calls.set(callId, { ...call, card })
        }
        // A card shown as proposed that could not be stored says why.
        for (const [callId, reason] of stored.refused) {
          const call = calls.get(callId)
          if (call !== undefined)
            calls.set(callId, { ...call, state: 'refused', reason })
        }
      }
      // The gate may have turned sensitive on this local route mid-turn.
      route = routeLine(stream.target, gate.via, gate.sensitive)
      finished = {
        state,
        text: answerText,
        route:
          state === 'failed'
            ? `${providerLabel(stream.target.provider)} did not answer`
            : route,
        calls: [...calls.values()],
        refs,
      }
    }
    reachedEnd = true
  } finally {
    // However the generator ends — drained, or returned by a cancelled
    // reader — the answer row is settled and the run closed.
    if (opened !== null) await opened.close()
    const final: Finish = finished ?? {
      state: 'stopped',
      text: text.trim(),
      route,
      calls: [...calls.values()].map((c) =>
        c.state === 'running' ? { ...c, state: 'failed' } : c,
      ),
      refs: await Effect.runPromise(
        freezeRefsProgram(text.trim(), touched, seen).pipe(
          Effect.orElseSucceed((): Array<AskRef> => []),
        ),
      ),
    }
    const row = await Effect.runPromise(
      finishProgram(
        begun,
        final,
        lastTarget === null
          ? null
          : { target: lastTarget, tokensIn: null, tokensOut: null },
      ).pipe(Effect.orElseSucceed(() => undefined)),
    )
    if (reachedEnd && row !== undefined) {
      const view = await Effect.runPromise(
        turnViewsProgram(input.userId, [row]).pipe(
          Effect.map((views) => views.at(0) ?? turnView(row, false)),
          Effect.orElseSucceed(() => turnView(row, false)),
        ),
      )
      yield { type: 'end', turn: view }
    }
  }
}

/**
 * `askEvents` as the stream a server fn hands the browser. A cancel from the
 * reader aborts the provider call and settles the turn as stopped.
 */
export function askStream(input: AskInput): ReadableStream<AskEvent> {
  const abort = new AbortController()
  const events = askEvents({ ...input, abortSignal: abort.signal })
  return new ReadableStream<AskEvent>({
    async pull(controller) {
      const next = await events.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      abort.abort()
      await events.return(undefined)
    },
  })
}
