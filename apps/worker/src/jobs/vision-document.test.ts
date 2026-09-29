import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { PDFDocument } from 'pdf-lib'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { aiUsage, document, entity } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { enqueued } from '#web/test/queue-stub'
import { clearAiRouteProgram, setAiRouteProgram } from '#web/lib/ai/route'
import { JobPermanent } from '../run-job'
import { ExtractionStore } from './extract-document'
import {
  runVisionDocument,
  visionDocument,
  visionDocumentData,
} from './vision-document'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * SPA-94, Read with vision, against a real database and an injected model
 * (`MockLanguageModelV4`): the route, the sensitivity read, `complete()`'s
 * `ai_usage` row and extraction's own `markExtracted` / `onExtracted` are
 * the real ones; only the blob read is stood in for, handing over a PDF with
 * no text layer. Nothing reaches a network.
 */

const USER = FIXTURE_ACTOR.id

/** A scan: `pages` pages with a shape drawn and no text layer at all. */
async function scannedPdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i++)
    pdf
      .addPage([300, 400])
      .drawRectangle({ x: 10, y: 10, width: 50 + i, height: 50 })
  return pdf.save()
}

/** The real store, with the blob read replaced by these bytes. */
function storeWith(bytes: Uint8Array): Layer.Layer<ExtractionStore> {
  const real = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        return yield* ExtractionStore
      }),
      ExtractionStore.layer,
    ),
  )
  return Layer.succeed(
    ExtractionStore,
    ExtractionStore.of({ ...real, bytes: () => Effect.succeed(bytes) }),
  )
}

/** A document the extractor left at `status`, a PDF with stored bytes. */
async function scan(
  status: 'unsupported' | 'failed' = 'unsupported',
  filename = `scanned deck ${randomUUID().slice(0, 8)}.pdf`,
): Promise<string> {
  const [row] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: filename })
    .returning({ id: entity.id })
  // A fixture standing in for the extraction job whose verdict this reads.
  await db.insert(document).values({
    entityId: row.id,
    filename,
    mime: 'application/pdf',
    blobSha: randomUUID().replace(/-/g, ''),
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: status,
    extractionError:
      status === 'unsupported'
        ? 'No text layer — probably a scanned document'
        : 'Blob integrity check failed',
  })
  return row.id
}

type Call = { files: Array<{ mediaType: string; data: unknown }>; text: string }

/**
 * A text model that answers each call with `answer(n)` for the n-th call, and
 * records what each call carried — the file parts and the prompt's text.
 */
function mockModel(answer: (n: number, call: Call) => string | Error) {
  const calls: Array<Call> = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-vision',
    doGenerate: (options) => {
      const call: Call = { files: [], text: '' }
      for (const message of options.prompt) {
        if (message.role !== 'user') continue
        for (const part of message.content) {
          if (part.type === 'file')
            call.files.push({ mediaType: part.mediaType, data: part.data })
          if (part.type === 'text') call.text += part.text
        }
      }
      calls.push(call)
      const out = answer(calls.length, call)
      if (out instanceof Error) return Promise.reject(out)
      return Promise.resolve({
        content: [{ type: 'text', text: out }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 3000,
            noCache: 3000,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 400, text: 400, reasoning: undefined },
        },
        warnings: [],
      })
    },
  })
  return { model, calls }
}

/** The bytes of a file part, however the SDK tagged them. */
function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  const inner: unknown =
    typeof data === 'object' && data !== null
      ? Reflect.get(data, 'data')
      : undefined
  if (inner instanceof Uint8Array) return inner
  if (typeof inner === 'string') return Buffer.from(inner, 'base64')
  if (typeof data === 'string') return Buffer.from(data, 'base64')
  throw new Error(`unexpected file data: ${typeof data}`)
}

/** Pages 1–2 answered in the first call, page 3 in the second. */
const pagesOf = (n: number) =>
  n === 1
    ? '[Page 1]\nAcme Robotics — Series A\n\n[Page 2]\nWarehouse picking arms, 40 customers'
    : '[Page 3]\nRaising $12M at a $48M pre-money valuation'

const run = (documentId: string, bytes: Uint8Array, seam: object) =>
  Effect.runPromiseExit(
    runVisionDocument({ documentId, userId: USER }, seam).pipe(
      Effect.provide(storeWith(bytes)),
    ),
  )

const row = async (id: string) =>
  (
    await db
      .select({
        status: document.extractionStatus,
        error: document.extractionError,
        text: document.extractedText,
        tsvHit: sql<boolean>`${document.tsv} @@ phraseto_tsquery('english', 'warehouse picking arms')`,
      })
      .from(document)
      .where(eq(document.entityId, id))
  ).at(0)

const usage = () =>
  db
    .select({ lane: aiUsage.lane, tokensIn: aiUsage.tokensIn })
    .from(aiUsage)
    .where(eq(aiUsage.callerId, USER))

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(aiUsage).where(isNotNull(aiUsage.id))
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'vision',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    }),
  )
})

describe('document.vision — a read that succeeds', () => {
  it('sends each page range as a PDF file part, writes text and tsv together, and hands on to chunking', async () => {
    const id = await scan()
    const { model, calls } = mockModel((n) => pagesOf(n))

    const exit = await run(id, await scannedPdf(3), {
      model,
      pagesPerChunk: 2,
    })
    expect(exit._tag).toBe('Success')

    // Two calls: pages 1–2, then page 3 — each one PDF of just that range.
    expect(calls).toHaveLength(2)
    const pageCounts: Array<number> = []
    for (const call of calls) {
      expect(call.files).toHaveLength(1)
      expect(call.files[0].mediaType).toBe('application/pdf')
      const part = await PDFDocument.load(bytesOf(call.files[0].data))
      pageCounts.push(part.getPageCount())
    }
    expect(pageCounts).toEqual([2, 1])
    expect(calls[0].text).toContain('pages 1–2')
    expect(calls[1].text).toContain('page 3')

    const after = await row(id)
    expect(after?.status).toBe('done')
    expect(after?.error).toBeNull()
    expect(after?.text).toBe(
      [
        '[Page 1]\nAcme Robotics — Series A',
        '[Page 2]\nWarehouse picking arms, 40 customers',
        '[Page 3]\nRaising $12M at a $48M pre-money valuation',
      ].join('\n\n'),
    )
    // Same statement as the text: search finds the phrase.
    expect(after?.tsvHit).toBe(true)

    // One ai_usage row per chunk, under the vision lane.
    const rows = await usage()
    expect(rows).toEqual([
      { lane: 'vision', tokensIn: 3000 },
      { lane: 'vision', tokensIn: 3000 },
    ])

    // document.extracted fired: chunking follows as it does for a text layer.
    expect(enqueued.map((e) => e.name)).toContain(QUEUES.embedDocument)
  })
})

describe('document.vision — a read that fails', () => {
  it('a failing page range leaves the document unsupported with the provider’s error, no text', async () => {
    const id = await scan()
    const { model, calls } = mockModel((n) =>
      n === 1 ? pagesOf(1) : new Error('overloaded_error: Overloaded'),
    )

    const exit = await run(id, await scannedPdf(3), {
      model,
      pagesPerChunk: 2,
    })
    expect(exit._tag).toBe('Failure')
    expect(calls).toHaveLength(2)

    const after = await row(id)
    expect(after?.status).toBe('unsupported')
    expect(after?.text).toBeNull()
    expect(after?.error).toContain('overloaded_error: Overloaded')
    expect(enqueued).toEqual([])
    // The range that answered was paid for, and recorded.
    expect(await usage()).toHaveLength(1)
  })

  it('a model that reads no text leaves the document unsupported and says so', async () => {
    const id = await scan()
    const { model } = mockModel(() => '')
    const exit = await run(id, await scannedPdf(1), { model })
    expect(exit._tag).toBe('Failure')
    const after = await row(id)
    expect(after?.status).toBe('unsupported')
    expect(after?.text).toBeNull()
    expect(after?.error).toMatch(/read no text/)
  })

  it('an unrouted vision lane makes no call and names the lane', async () => {
    await Effect.runPromise(clearAiRouteProgram('vision', 'normal'))
    const id = await scan()
    const { model, calls } = mockModel(() => pagesOf(1))
    const exit = await run(id, await scannedPdf(1), { model })
    expect(exit._tag).toBe('Failure')
    expect(calls).toHaveLength(0)
    expect((await row(id))?.error).toBe(
      'No model is routed for the vision lane',
    )
  })

  it('a sensitive document routed to the cloud is refused, never sent', async () => {
    const id = await scan()
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    // The sensitive cell routed to the cloud: the refusal is `complete()`'s.
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'vision',
        sensitivity: 'sensitive',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      }),
    )
    const { model, calls } = mockModel(() => pagesOf(1))
    const exit = await run(id, await scannedPdf(1), { model })
    expect(exit._tag).toBe('Failure')
    expect(calls).toHaveLength(0)
    const after = await row(id)
    expect(after?.status).toBe('unsupported')
    expect(after?.error).toMatch(/Sensitive material is not sent/)
  })
})

describe('document.vision — refusals leave the row alone', () => {
  it('a failed document is not read: its problem is not a missing text layer', async () => {
    const id = await scan('failed')
    const { model, calls } = mockModel(() => pagesOf(1))
    const failure = await Effect.runPromise(
      Effect.flip(
        runVisionDocument({ documentId: id, userId: USER }, { model }).pipe(
          Effect.provide(storeWith(await scannedPdf(1))),
        ),
      ),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toBe(
      'Only a stored PDF with no text layer is read with vision',
    )
    expect(calls).toHaveLength(0)
    expect((await row(id))?.error).toBe('Blob integrity check failed')
  })

  it('never retries, and carries who pressed and what', () => {
    expect(visionDocument.retry?.limit).toBe(0)
    expect(visionDocument.name).toBe(QUEUES.visionDocument)
    expect(
      visionDocumentData.safeParse({ documentId: randomUUID() }).success,
    ).toBe(false)
  })
})
