import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  activity,
  aiRoute,
  credential,
  document,
  documentKind,
  suggestion,
} from '@spaces/db/schema'
import { DOCUMENT_KINDS, guessDocumentKind } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { birthDocumentProgram } from '#/lib/documents/birth'
import { onDocumentExtracted } from '#/lib/documents/on-extracted'
import { offersReadDeck } from '#/lib/documents/read-deck-gate'
import { storeCredential } from '@spaces/core/writes/vault'
import {
  CLASSIFY_OPTIONS,
  classifyDocumentProgram,
} from '#/lib/ai/classify-document'
import { acceptProgram, rejectProgram } from '#/lib/ai/propose'
import { setAiRouteProgram } from '#/lib/ai/route'
import { JobPermanent } from '../run-job'
import { runClassifyDocument } from './classify-document'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-62, the lane, from extraction's tail to the inbox decision. It sits
 * beside the worker because it runs the job, and nothing under `lib/` may
 * import the worker. Through an injected model (`MockLanguageModelV4`, as
 * the deck reader's test): the route, the sensitivity read, the suggestion
 * row, the accept and the reject are all real; nothing reaches a network.
 */

const USER = FIXTURE_ACTOR.id
const DECIDER = { type: 'user', id: USER } as const

type Answer = {
  kinds: Array<{ kind: string; confidence: number }>
  reason: string
}

function mockModel(answer: Answer) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 40,
            noCache: 40,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      }),
  })
}

const CAP_TABLE: Answer = {
  kinds: [{ kind: 'cap_table', confidence: 0.9 }],
  reason: 'A ledger of holders, share classes and percentages.',
}

async function routeClassify() {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-classify-0001',
    meta: {},
    createdBy: USER,
  })
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'classify',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

/** An upload, kinded as upload kinds it, whose text is extracted. */
async function upload(filename: string, kind?: DocumentKind): Promise<string> {
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: null,
      filename,
      mime: 'application/pdf',
      sizeBytes: 2048,
      kind: kind ?? guessDocumentKind(filename),
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [],
      actor: { userId: USER },
    }),
  )
  // Exempt from the one-writer rule: the state an extraction leaves.
  await db
    .update(document)
    .set({
      extractionStatus: 'done',
      extractedText:
        'Holder | Class | Shares | %\nFounder A | Common | 4,000,000 | 40%',
    })
    .where(eq(document.entityId, id))
  return id
}

/**
 * The whole path as the worker runs it: extraction's tail enqueues, and a
 * classify job enqueued is a classify job run.
 */
async function extractThenClassify(id: string, answer: Answer) {
  enqueued.length = 0
  await Effect.runPromise(onDocumentExtracted(id))
  const model = mockModel(answer)
  for (const job of enqueued.filter(
    (e) => e.name === QUEUES.classifyDocument,
  )) {
    expect(job.data).toEqual({ documentId: id })
    await Effect.runPromise(runClassifyDocument({ documentId: id }, { model }))
  }
  return model
}

const classificationsOf = (id: string) =>
  db
    .select()
    .from(suggestion)
    .where(
      and(eq(suggestion.entityId, id), eq(suggestion.kind, 'document_kind')),
    )

const kindOf = async (id: string) =>
  (
    await db
      .select({
        kind: document.kind,
        extractionStatus: document.extractionStatus,
      })
      .from(document)
      .where(eq(document.entityId, id))
  ).at(0)

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the vocabulary comes from the schema', () => {
  it('DOCUMENT_KINDS is the document_kind enum, member for member', () => {
    expect([...documentKind.enumValues]).toEqual([...DOCUMENT_KINDS])
  })

  it('the options are that enum minus other', () => {
    expect([...CLASSIFY_OPTIONS]).toEqual(
      documentKind.enumValues.filter((k) => k !== 'other'),
    )
    expect(CLASSIFY_OPTIONS).not.toContain('other')
  })

  it('and they are what the model is handed', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf')
    const model = mockModel(CAP_TABLE)
    await Effect.runPromise(classifyDocumentProgram({ documentId: id, model }))
    expect(model.doGenerateCalls).toHaveLength(1)
    const call = model.doGenerateCalls[0]
    const format = call.responseFormat
    expect(format?.type).toBe('json')
    const schema = format?.type === 'json' ? format.schema : undefined
    expect(JSON.stringify(schema)).toContain(
      JSON.stringify({ type: 'string', enum: [...CLASSIFY_OPTIONS] }),
    )
    expect(JSON.stringify(call.prompt)).toContain(`[doc:${id}#0]`)
  })
})

describe('classify — who is classified', () => {
  it('an upload left at other gets exactly one classify suggestion', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf')
    expect((await kindOf(id))?.kind).toBe('other')

    const model = await extractThenClassify(id, CAP_TABLE)
    expect(model.doGenerateCalls).toHaveLength(1)

    const rows = await classificationsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('open')
    expect(rows[0].payload).toEqual({ kind: 'cap_table', confidence: 0.9 })
    expect(rows[0].proposedByType).toBe('system')
    expect(rows[0].refs).toEqual([`doc:${id}#0`])
    expect(rows[0].rationale).toContain('this looks like a cap table')
    // Proposed, not written.
    expect((await kindOf(id))?.kind).toBe('other')
  })

  it('an upload whose filename gave it a kind gets none', async () => {
    await routeClassify()
    const id = await upload('Acme pitch deck.pdf')
    expect((await kindOf(id))?.kind).toBe('deck')

    const model = await extractThenClassify(id, CAP_TABLE)
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await classificationsOf(id)).toHaveLength(0)

    // Even run by hand, the program refuses to ask.
    const direct = await Effect.runPromise(
      classifyDocumentProgram({ documentId: id, model }),
    )
    expect(direct.status).toBe('skipped')
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it('a file from a bound folder carrying a folder-derived kind gets none', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf', 'legal')
    const model = await extractThenClassify(id, CAP_TABLE)
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await classificationsOf(id)).toHaveLength(0)
  })
})

describe('classify — answers outside the options', () => {
  it('drops them and says so in the rationale, keeping the first valid kind', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf')
    const model = mockModel({
      kinds: [
        { kind: 'memo', confidence: 0.6 },
        { kind: 'cap_table', confidence: 0.3 },
      ],
      reason: 'Holders and percentages.',
    })
    const result = await Effect.runPromise(
      classifyDocumentProgram({ documentId: id, model }),
    )
    expect(result.status).toBe('proposed')
    const [row] = await classificationsOf(id)
    expect(row.payload).toEqual({ kind: 'cap_table', confidence: 0.3 })
    expect(row.rationale).toContain('Dropped "memo"')
  })

  it('with nothing proposable left it writes nothing, and does not raise', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf')
    const model = mockModel({
      kinds: [
        { kind: 'other', confidence: 0.8 },
        { kind: 'memo', confidence: 0.2 },
      ],
      reason: 'Unclear.',
    })
    const result = await Effect.runPromise(
      classifyDocumentProgram({ documentId: id, model }),
    )
    expect(result.status).toBe('skipped')
    if (result.status === 'skipped')
      expect(result.reason).toContain('Dropped "other", "memo"')
    expect(await classificationsOf(id)).toHaveLength(0)
  })
})

describe('classify — the decision', () => {
  it('accepting writes the kind and one document.reclassified row by the accepter', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf')
    await extractThenClassify(id, CAP_TABLE)
    const [row] = await classificationsOf(id)

    enqueued.length = 0
    const accepted = await Effect.runPromise(acceptProgram(row.id, DECIDER))
    expect(accepted.kind).toBe('document_kind')
    expect((await kindOf(id))?.kind).toBe('cap_table')

    const events = await db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.subjectEntityId, id),
          eq(activity.verb, 'document.reclassified'),
        ),
      )
    expect(events).toHaveLength(1)
    expect(events[0].actorId).toBe(USER)
    expect(events[0].meta).toEqual({
      from: 'other',
      to: 'cap_table',
      suggestionId: row.id,
    })
    expect(enqueued).toEqual([])
  })

  it('accepting a deck enqueues nothing — the Read deck button simply appears', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf')
    await extractThenClassify(id, {
      kinds: [{ kind: 'deck', confidence: 0.8 }],
      reason: 'Slides: problem, solution, team, ask.',
    })
    const [row] = await classificationsOf(id)
    const before = await kindOf(id)
    expect(before && offersReadDeck(before, true)).toBe(false)

    enqueued.length = 0
    await Effect.runPromise(acceptProgram(row.id, DECIDER))
    expect(enqueued).toEqual([])
    const after = await kindOf(id)
    expect(after?.kind).toBe('deck')
    expect(after && offersReadDeck(after, true)).toBe(true)
  })

  it('rejecting leaves the document at other, and it is never proposed again', async () => {
    await routeClassify()
    const id = await upload('Acme holdings.pdf')
    await extractThenClassify(id, CAP_TABLE)
    const [row] = await classificationsOf(id)

    await Effect.runPromise(rejectProgram(row.id, DECIDER))
    expect((await kindOf(id))?.kind).toBe('other')

    // A re-extraction runs the whole tail again.
    const model = await extractThenClassify(id, CAP_TABLE)
    expect(model.doGenerateCalls).toHaveLength(0)
    const rows = await classificationsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('rejected')
    expect((await kindOf(id))?.kind).toBe('other')
  })
})

describe('document.classify — the job', () => {
  it('fails permanently, with no network, when the lane is not routed', async () => {
    const id = await upload('Acme holdings.pdf')
    const model = mockModel(CAP_TABLE)
    const failure = await Effect.runPromise(
      Effect.flip(runClassifyDocument({ documentId: id }, { model })),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toBe('No model is routed for the classify lane')
    expect(model.doGenerateCalls).toHaveLength(0)
  })
})
