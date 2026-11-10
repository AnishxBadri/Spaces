import { Effect } from 'effect'
import { isStepCount, streamText } from 'ai'
import type { LanguageModel, LanguageModelUsage, ToolSet } from 'ai'
import { db } from '@spaces/db'
import { aiUsage } from '@spaces/db/schema'
import { estimateTokens } from '@spaces/core/ai/caps'
import type { ContextItem } from '@spaces/core/context/types'
import { resolveLanguageModel } from './providers'
import type { ResolveModelFailure } from './providers'
import { buildRequest, requestChars } from './prompt'
import type { PromptTurn } from './prompt'
import { checkCapProgram } from './caps'
import type { CapExceeded, CapReadFailed } from './caps'
import {
  laneTargetProgram,
  ProviderCallFailed,
  readsCacheMarkers,
  usageLine,
  usageOf,
} from './complete'
import type { Caller, SensitiveRouteRefused } from './complete'
import type { AiTarget, LaneNotRouted, RouteReadFailed } from './route'
import type { AiLane, AiSensitivity } from './lanes'
import type { SensitivityVia } from './sensitivity'

/**
 * The streaming half of `complete()`: the same lane routing, sensitive-to-
 * cloud refusal and cap check, run before any model is built, then the model
 * streamed as text. One `ai_usage` row is written however the stream ends.
 * - The policy is `laneTargetProgram`'s, so a sensitive call never reaches a
 *   cloud provider here either.
 * - `opts.model` is the test seam, as for `complete()`.
 * - With `tools`, the model may call them for up to `maxSteps` steps; each
 *   call and its outcome arrive as parts between the text deltas.
 */

export type StreamOptions = {
  caller: Caller
  sensitivity: AiSensitivity
  via?: SensitivityVia
  /** The whole request's ceiling, system part and subject included; not the conversation. */
  budgetChars: number
  /** The lane's fixed text, sent as the system part (`CompleteOptions.instructions`). */
  instructions: string
  /** What this call is about (the question), rendered after the context. */
  subject?: string
  /**
   * Earlier turns as real messages, oldest first. Present, the last two
   * messages carry cache markers on a provider that reads them.
   */
  conversation?: ReadonlyArray<PromptTurn>
  model?: LanguageModel
  maxOutputTokens?: number
  abortSignal?: AbortSignal
  /** The run this call is a step of, written to `ai_usage.run_id`. */
  runId?: string
  tools?: ToolSet
  /** Model steps when tools are given; default 6. */
  maxSteps?: number
}

/** What the stream carries: the answer's text, and each tool call's progress. */
export type StreamPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call' | 'tool-result' | 'tool-error'
      toolCallId: string
      toolName: string
    }

export type StreamOpenFailure =
  | LaneNotRouted
  | RouteReadFailed
  | SensitiveRouteRefused
  | ResolveModelFailure
  | CapExceeded
  | CapReadFailed

export type OpenedStream = {
  target: AiTarget
  /** The answer's text delta by delta, and tool calls; throws `ProviderCallFailed`. */
  parts: AsyncIterable<StreamPart>
  /** Writes the usage row if it is not written yet; call when done reading. */
  close: () => Promise<void>
}

export const openStreamProgram = Effect.fn('openStream')(function* (
  lane: AiLane,
  items: ReadonlyArray<ContextItem>,
  opts: StreamOptions,
): Effect.fn.Return<OpenedStream, StreamOpenFailure> {
  const target = yield* laneTargetProgram(lane, opts)
  yield* checkCapProgram(opts.budgetChars)
  const model =
    opts.model ??
    (yield* resolveLanguageModel(target.provider, {
      modelId: target.model,
      ...(opts.caller.type === 'user' ? { userId: opts.caller.id } : {}),
    })).model
  const request = buildRequest({
    instructions: opts.instructions,
    items,
    subject: opts.subject ?? '',
    budgetChars: opts.budgetChars,
    cache: readsCacheMarkers(target.provider),
    ...(opts.conversation === undefined
      ? {}
      : { conversation: opts.conversation }),
  })
  const result = streamText({
    model,
    ...request,
    ...(opts.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: opts.maxOutputTokens }),
    ...(opts.abortSignal === undefined
      ? {}
      : { abortSignal: opts.abortSignal }),
    ...(opts.tools === undefined
      ? {}
      : { tools: opts.tools, stopWhen: isStepCount(opts.maxSteps ?? 6) }),
  })

  // The usage row is written once, however the stream ends — drained,
  // failed, cancelled by the reader, or never read — so a stopped call still
  // counts against the cap.
  // - Off a drained stream the provider's counts; otherwise the prompt and the
  //   text streamed so far, estimated as the cap estimates them.
  let streamed = 0
  let usage: LanguageModelUsage | null = null
  let recorded = false
  async function close(): Promise<void> {
    if (recorded) return
    recorded = true
    await db.insert(aiUsage).values({
      lane,
      provider: target.provider,
      model: target.model,
      tokensIn: usage?.inputTokens ?? estimateTokens(requestChars(request)),
      tokensOut: usage?.outputTokens ?? estimateTokens(streamed),
      callerType: opts.caller.type,
      callerId: opts.caller.type === 'system' ? null : opts.caller.id,
      jobRunId: null,
      runId: opts.runId ?? null,
    })
    if (usage !== null)
      Effect.runSync(Effect.log(usageLine(lane, target, usageOf(usage))))
  }

  async function* parts(): AsyncGenerator<StreamPart, void> {
    try {
      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          streamed += part.text.length
          yield { type: 'text', text: part.text }
        } else if (
          part.type === 'tool-call' ||
          part.type === 'tool-result' ||
          part.type === 'tool-error'
        )
          yield {
            type: part.type,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
          }
        else if (part.type === 'error')
          throw new ProviderCallFailed({
            provider: target.provider,
            cause: part.error,
          })
      }
      usage = await result.totalUsage
    } finally {
      await close()
    }
  }

  return { target, parts: parts(), close }
})
