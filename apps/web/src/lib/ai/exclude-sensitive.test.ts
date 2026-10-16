import { Effect } from 'effect'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { chunk, entity } from '@spaces/db/schema'
import { birthDocumentProgram } from '@spaces/core/writes/documents/birth'
import { stampSensitivity } from '@spaces/core/writes/ai/stamp-sensitivity'
import { enqueued } from '#/test/queue-stub'
import { webEnqueue } from '#/lib/enqueue-live'
import { fileDocumentProgram } from '#/lib/documents/refile'
import { toolRegistry } from '#/lib/mcp/registry'
import { askEvents } from '#/lib/ask/turn'
import type { AskEvent } from '#/lib/ask/types'
import { createSpaceRow } from '#/lib/server/shared'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  clearAiRouteProgram,
  excludeSensitiveProgram,
  setAiRouteProgram,
} from './route'
import { setEntitySensitiveProgram } from './sensitivity-for'
import { summarizeProgram } from './summarize'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * A normal company whose context reaches a sensitive neighbour — a document
 * filed against it and also under a flagged space. On a cloud route the
 * assembler leaves that document's chunks out; on a local route they stay.
 * The route is injected through `ai_route`, the model through the AI SDK
 * mock: nothing reaches a network.
 */

const run = <TValue, TError>(e: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(e)

const PLAIN = 'Ohmium ships electrolyser stacks to steelmakers.'
const SECRET = 'Term sheet: pre-money of 41 million, board seat to Fund II.'

const usage = {
  inputTokens: {
    total: 30,
    noCache: 30,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
}

const route = (
  sensitivity: 'normal' | 'sensitive',
  provider: 'anthropic' | 'ollama',
) =>
  run(
    setAiRouteProgram({
      lane: 'synthesize',
      sensitivity,
      provider,
      model: provider === 'ollama' ? 'llama3.2' : 'claude-opus-5',
    }),
  )

/** A text model that records every prompt it is handed. */
function textModel(answer: string) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      }),
  })
}

/** A streaming model that calls one tool, then answers. */
function agentModel(call: { toolName: string; input: unknown }) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async (options) => {
      if (options.prompt.at(-1)?.role === 'tool')
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start' as const, id: 't' },
              { type: 'text-delta' as const, id: 't', delta: 'Done.' },
              { type: 'text-end' as const, id: 't' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage,
              },
            ],
          }),
        }
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call' as const,
              toolCallId: `call-${String(options.prompt.length)}`,
              toolName: call.toolName,
              input: JSON.stringify(call.input),
            },
            {
              type: 'finish' as const,
              finishReason: {
                unified: 'tool-calls' as const,
                raw: 'tool_use',
              },
              usage,
            },
          ],
        }),
      }
    },
  })
}

let n = 0
const tag = () => `${String(++n)}_${Math.random().toString(36).slice(2, 6)}`

async function aDocOn(companyId: string, text: string): Promise<string> {
  const { id } = await run(
    birthDocumentProgram({
      blobSha: null,
      filename: `deck-${tag()}.html`,
      url: `https://example.com/${tag()}`,
      mime: 'text/html',
      sizeBytes: null,
      kind: 'deck',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [{ kind: 'record', entityId: companyId }],
      actor: { userId: FIXTURE_ACTOR.id },
    }).pipe(Effect.provide(webEnqueue)),
  )
  await db.insert(chunk).values({
    entityId: id,
    sourceKind: 'document',
    sourceKey: '',
    idx: 0,
    text,
  })
  await run(stampSensitivity(id))
  return id
}

/** Ohmium, normal, with a plain deck and a deck also filed under a flagged space. */
async function fixture() {
  const co = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Ohmium ${tag()}` })
      .returning({ id: entity.id })
  ).at(0)
  if (!co) throw new Error('no company')
  const plain = await aDocOn(co.id, PLAIN)
  const secret = await aDocOn(co.id, SECRET)
  const space = await createSpaceRow(`Fund II ${tag()}`, null, FIXTURE_ACTOR.id)
  await run(setEntitySensitiveProgram(space, true))
  await run(
    fileDocumentProgram(FIXTURE_ACTOR.id, {
      documentId: secret,
      target: { kind: 'space', entityId: space },
    }),
  )
  return { company: co.id, plain, secret }
}

async function collect(events: AsyncIterable<AskEvent>) {
  const out: Array<AskEvent> = []
  for await (const e of events) out.push(e)
  return out
}

beforeEach(async () => {
  enqueued.length = 0
  vi.restoreAllMocks()
  await run(clearAiRouteProgram('synthesize', 'normal'))
  await run(clearAiRouteProgram('synthesize', 'sensitive'))
})

describe('excludeSensitive from the lane’s route', () => {
  it('is true unless the lane routes to a local provider', async () => {
    expect(await run(excludeSensitiveProgram('synthesize', 'normal'))).toBe(
      true,
    )
    await route('normal', 'anthropic')
    await route('sensitive', 'ollama')
    expect(await run(excludeSensitiveProgram('synthesize', 'normal'))).toBe(
      true,
    )
    expect(await run(excludeSensitiveProgram('synthesize', 'sensitive'))).toBe(
      false,
    )
  })

  it('Summarize on a cloud route never carries the sensitive neighbour’s chunk; on a local route it does', async () => {
    const f = await fixture()
    await route('normal', 'anthropic')
    await route('sensitive', 'ollama')

    const cloud = textModel(`Ohmium ships stacks [doc:${f.plain}#0].`)
    await run(
      summarizeProgram({
        recordId: f.company,
        documentId: null,
        userId: FIXTURE_ACTOR.id,
        model: cloud,
      }),
    )
    const sent = JSON.stringify(cloud.doGenerateCalls.at(0)?.prompt)
    expect(sent).toContain(PLAIN)
    expect(sent).not.toContain(SECRET)
    expect(sent).not.toContain(f.secret)

    await route('normal', 'ollama')
    const local = textModel(`Ohmium ships stacks [doc:${f.plain}#0].`)
    await run(
      summarizeProgram({
        recordId: f.company,
        documentId: null,
        userId: FIXTURE_ACTOR.id,
        model: local,
      }),
    )
    expect(JSON.stringify(local.doGenerateCalls.at(0)?.prompt)).toContain(
      SECRET,
    )
  })

  it('Ask’s get_context on a cloud route drops the chunk and stays on the cloud; on a local route it is kept', async () => {
    const f = await fixture()
    await route('normal', 'anthropic')
    await route('sensitive', 'ollama')
    const spy = vi.spyOn(toolRegistry, 'call')

    const cloud = agentModel({
      toolName: 'get_context',
      input: { entity: f.company },
    })
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Where does Ohmium stand?',
        scope: [],
        model: cloud,
      }),
    )
    expect(spy).toHaveBeenCalledWith(
      'get_context',
      expect.objectContaining({ excludeSensitive: true }),
      { entity: f.company },
    )
    const toCloud = JSON.stringify(cloud.doStreamCalls.map((c) => c.prompt))
    expect(toCloud).toContain(PLAIN)
    expect(toCloud).not.toContain(SECRET)
    expect(events.flatMap((e) => (e.type === 'route' ? [e.line] : []))).toEqual(
      ['Anthropic · claude-opus-5'],
    )

    await route('normal', 'ollama')
    const local = agentModel({
      toolName: 'get_context',
      input: { entity: f.company },
    })
    await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Where does Ohmium stand?',
        scope: [],
        model: local,
      }),
    )
    expect(spy).toHaveBeenLastCalledWith(
      'get_context',
      expect.objectContaining({ excludeSensitive: false }),
      { entity: f.company },
    )
    expect(JSON.stringify(local.doStreamCalls.map((c) => c.prompt))).toContain(
      SECRET,
    )
  })
})
