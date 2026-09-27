import { randomUUID } from 'node:crypto'
import { Effect, Exit } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { asc, eq, isNull } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiRun,
  aiUsage,
  chunk,
  document,
  entity,
  link,
  suggestion,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '#/lib/entities/resolve'
import { readDeckProgram } from './read-deck'
import { readDeckSummarizeProgram } from './read-deck-summarize'
import { setAiRouteProgram } from './route'
import { suggestionOutputRef } from './run'
import { runDetailProgram, usageViewProgram } from './usage'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-100. The run log, through the first two-step run: Read deck and
 * summarize. Both lanes answer through injected models
 * (`MockLanguageModelV4`), so the route, the extraction cache, the ai_usage
 * rows, the suggestions and the `ai_run` row are all real and nothing reaches
 * a network.
 */

const USER = FIXTURE_ACTOR.id

const usage = (tokensIn: number, tokensOut: number) => ({
  inputTokens: {
    total: tokensIn,
    noCache: tokensIn,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: tokensOut, text: tokensOut, reasoning: undefined },
})

/** A model answering every call with `text`, or refusing with `error`. */
function model(answer: () => string | Error, tokens: [number, number]) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () => {
      const out = answer()
      if (out instanceof Error) return Promise.reject(out)
      return Promise.resolve({
        content: [{ type: 'text', text: out }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usage(tokens[0], tokens[1]),
        warnings: [],
      })
    },
  })
}

const extractAnswer = (documentId: string) =>
  JSON.stringify({
    description: {
      value: 'Liquid cooling for edge data centres',
      refs: [`doc:${documentId}#0`],
      confidence: 0.9,
    },
    location: {
      value: 'Berlin',
      refs: [`doc:${documentId}#2`],
      confidence: 0.7,
    },
    founders: {
      value: [{ name: 'Ada Founder', role: 'CEO' }],
      refs: [`doc:${documentId}#1`],
      confidence: 0.8,
    },
  })

const summaryAnswer = (documentId: string) =>
  [
    `Deckco builds liquid cooling for edge data centres [doc:${documentId}#0].`,
    '',
    '## Business',
    `- Sold B2B to operators [doc:${documentId}#1].`,
  ].join('\n')

beforeAll(async () => {
  for (const lane of ['extract', 'synthesize'] as const)
    await Effect.runPromise(
      setAiRouteProgram({
        lane,
        sensitivity: 'normal',
        provider: 'anthropic',
        model: lane === 'extract' ? 'claude-haiku-4-5' : 'claude-sonnet-4-5',
      }),
    )
})

/** A company, and a chunked, extracted deck filed against it. */
async function deckOnCompany() {
  const tag = randomUUID().slice(0, 8)
  const company = await resolveEntity({
    kind: 'company',
    name: `Deckco ${tag}`,
    keys: { domain: `deckco-${tag}.example` },
    source: { class: 'manual' },
  })
  const docEnt = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: `deck-${tag}.pdf` })
      .returning({ id: entity.id })
  ).at(0)
  if (!docEnt) throw new Error('no document entity')
  // Exempt from the one-writer rule: a fixture wanting a deck already
  // extracted, the state the button appears in. A blob sha so the extract
  // step goes through the extraction cache.
  await db.insert(document).values({
    entityId: docEnt.id,
    filename: `deck-${tag}.pdf`,
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: 'Deckco builds liquid cooling for edge DCs. Berlin. Seed.',
    blobSha: `sha-${tag}`,
  })
  await db.insert(chunk).values(
    [
      'Deckco: liquid cooling for edge data centres.',
      'Founded by Ada Founder (CEO). Sold B2B to operators.',
      'Raising a seed round. HQ Berlin.',
    ].map((text, idx) => ({
      entityId: docEnt.id,
      sourceKind: 'document' as const,
      idx,
      text,
    })),
  )
  await db.insert(link).values({
    fromEntityId: docEnt.id,
    toEntityId: company.entityId,
    relation: 'tagged_in',
    source: 'manual',
  })
  return { companyId: company.entityId, documentId: docEnt.id }
}

const runRow = async (id: string) => {
  const row = (await db.select().from(aiRun).where(eq(aiRun.id, id))).at(0)
  if (!row) throw new Error(`no ai_run ${id}`)
  return row
}

describe('Read deck and summarize — one run, two ordered steps', () => {
  it('writes one ai_run with extract then synthesize, and every ai_usage row and suggestion carries it', async () => {
    const { companyId, documentId } = await deckOnCompany()
    const extract = model(() => extractAnswer(documentId), [300, 40])
    const synthesize = model(() => summaryAnswer(documentId), [900, 120])

    const result = await Effect.runPromise(
      readDeckSummarizeProgram({
        documentId,
        recordId: companyId,
        userId: USER,
        extractModel: extract,
        synthesizeModel: synthesize,
      }),
    )
    expect(extract.doGenerateCalls).toHaveLength(1)
    expect(synthesize.doGenerateCalls).toHaveLength(1)

    const run = await runRow(result.runId)
    expect(run.task).toBe('Read deck and summarize')
    expect(run.entityId).toBe(companyId)
    expect(run.status).toBe('done')
    expect(run.error).toBeNull()
    expect(run.finishedAt).not.toBeNull()
    expect(run.startedByType).toBe('user')
    expect(run.startedById).toBe(USER)
    // Two steps, in order, each carrying its own call's tokens.
    expect(run.steps.map((s) => s.tool)).toEqual(['extract', 'synthesize'])
    expect(run.steps[0].tokens_in).toBe(300)
    expect(run.steps[1].tokens_out).toBe(120)
    expect(run.steps[0].cached).toBeUndefined()
    expect(run.tokensIn).toBe(1200)
    expect(run.tokensOut).toBe(160)
    // Inputs are the refs the calls were shown; outputs the suggestions.
    expect(run.steps[0].input_refs).toContain(`doc:${documentId}#0`)
    expect(run.steps[1].input_refs).toContain(`doc:${documentId}#1`)
    expect(run.steps[1].output_ref).toBe(suggestionOutputRef(result.summary.id))

    // Both ai_usage rows carry the run.
    const calls = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.runId, result.runId))
      .orderBy(asc(aiUsage.at))
    expect(calls.map((c) => c.lane)).toEqual(['extract', 'synthesize'])

    // Every suggestion the run produced carries it: the patch, the identity
    // the deck named, and the summary note — three.
    const produced = await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.runId, result.runId))
    expect(produced.map((s) => s.kind).sort()).toEqual([
      'attribute_patch',
      'identity',
      'note',
    ])
    expect(produced.every((s) => s.entityId === companyId)).toBe(true)
    expect(result.read.suggestions.every((s) => s.runId === result.runId)).toBe(
      true,
    )
    expect(result.summary.runId).toBe(result.runId)
  })

  it('marks the extract step cached when the extraction cache answers', async () => {
    const { companyId, documentId } = await deckOnCompany()
    // First read stores the answer under the deck's bytes.
    await Effect.runPromise(
      readDeckProgram({
        documentId,
        userId: USER,
        model: model(() => extractAnswer(documentId), [300, 40]),
      }),
    )
    const extract = model(() => extractAnswer(documentId), [300, 40])
    const result = await Effect.runPromise(
      readDeckSummarizeProgram({
        documentId,
        recordId: companyId,
        userId: USER,
        extractModel: extract,
        synthesizeModel: model(() => summaryAnswer(documentId), [900, 120]),
      }),
    )
    expect(extract.doGenerateCalls).toHaveLength(0)
    const run = await runRow(result.runId)
    expect(run.steps[0].cached).toBe(true)
    expect(run.steps[0].tokens_in).toBeNull()
    expect(run.steps[0].model).toBe('claude-haiku-4-5')
    expect(run.tokensIn).toBe(900)
    const calls = await db
      .select({ lane: aiUsage.lane })
      .from(aiUsage)
      .where(eq(aiUsage.runId, result.runId))
    expect(calls.map((c) => c.lane)).toEqual(['synthesize'])
  })

  it('a failed second step leaves the run failed with the provider’s error, and step 1’s suggestion open and cited', async () => {
    const { companyId, documentId } = await deckOnCompany()
    const exit = await Effect.runPromiseExit(
      readDeckSummarizeProgram({
        documentId,
        recordId: companyId,
        userId: USER,
        extractModel: model(() => extractAnswer(documentId), [300, 40]),
        synthesizeModel: model(
          () => new Error('synthesize model is overloaded'),
          [0, 0],
        ),
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)

    const run = (
      await db.select().from(aiRun).where(eq(aiRun.entityId, companyId))
    ).at(0)
    if (!run) throw new Error('no run')
    expect(run.status).toBe('failed')
    expect(run.error).toContain('synthesize model is overloaded')
    expect(run.finishedAt).not.toBeNull()
    expect(run.steps.map((s) => s.tool)).toEqual(['extract'])

    const produced = await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.runId, run.id))
    const patch = produced.find((s) => s.kind === 'attribute_patch')
    expect(patch?.status).toBe('open')
    expect(patch?.refs).toContain(`doc:${documentId}#0`)
    expect(produced.some((s) => s.kind === 'note')).toBe(false)
  })
})

describe('one-step runs', () => {
  it('Read deck alone opens and closes its own one-step run', async () => {
    const { documentId } = await deckOnCompany()
    const result = await Effect.runPromise(
      readDeckProgram({
        documentId,
        userId: USER,
        model: model(() => extractAnswer(documentId), [300, 40]),
      }),
    )
    const runId = result.suggestions[0].runId
    if (runId === null) throw new Error('no run on the suggestion')
    const run = await runRow(runId)
    expect(run.task).toBe('Read deck')
    expect(run.entityId).toBe(documentId)
    expect(run.status).toBe('done')
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0].output_ref).toBe(
      suggestionOutputRef(result.suggestions[0].id),
    )
  })

  it('a refusal before any call leaves no run behind', async () => {
    const before = await db.select({ id: aiRun.id }).from(aiRun)
    const exit = await Effect.runPromiseExit(
      readDeckProgram({ documentId: randomUUID(), userId: USER }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const after = await db.select({ id: aiRun.id }).from(aiRun)
    expect(after).toHaveLength(before.length)
  })
})

describe('the Usage surface', () => {
  it('lists the run and resolves each step’s refs to names through cite.ts', async () => {
    const { companyId, documentId } = await deckOnCompany()
    const result = await Effect.runPromise(
      readDeckSummarizeProgram({
        documentId,
        recordId: companyId,
        userId: USER,
        extractModel: model(() => extractAnswer(documentId), [300, 40]),
        synthesizeModel: model(() => summaryAnswer(documentId), [900, 120]),
      }),
    )
    const view = await Effect.runPromise(usageViewProgram())
    const listed = view.runs.find((r) => r.id === result.runId)
    expect(listed?.task).toBe('Read deck and summarize')
    expect(listed?.steps).toBe(2)
    expect(listed?.suggestions.open).toBe(3)
    expect(listed?.record?.id).toBe(companyId)

    const detail = await Effect.runPromise(runDetailProgram(result.runId))
    if (!detail) throw new Error('no detail')
    expect(detail.calls).toBe(2)
    const [first, second] = detail.steps
    // `cite.ts` renders a document chunk as "<filename> · chunk <n>".
    expect(first.inputs.map((i) => i.label)).toContain(
      `${(await filename(documentId)) ?? ''} · chunk 0`,
    )
    expect(first.output?.kind).toBe('suggestion')
    expect(second.output).toMatchObject({
      kind: 'suggestion',
      suggestionKind: 'note',
      status: 'open',
    })
    expect(detail.suggestions).toHaveLength(3)
  })

  it('lists a call no run owns under the calls outside a run', async () => {
    await db.insert(aiUsage).values({
      lane: 'extract',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokensIn: 5,
      tokensOut: 1,
      callerType: 'user',
      callerId: USER,
    })
    const view = await Effect.runPromise(usageViewProgram())
    const lone = await db.select().from(aiUsage).where(isNull(aiUsage.runId))
    expect(view.loneCalls.map((c) => c.id).sort()).toEqual(
      lone.map((c) => c.id).sort(),
    )
  })
})

async function filename(documentId: string) {
  return (
    await db
      .select({ filename: document.filename })
      .from(document)
      .where(eq(document.entityId, documentId))
  ).at(0)?.filename
}
