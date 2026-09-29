import { Effect } from 'effect'
import { MockEmbeddingModelV4 } from 'ai/test'
import { asc, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { chunk, entity, workspace } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { EMBEDDABLE_ATTRIBUTES } from '@spaces/core/writes/ai/chunk-sources'
import { pinEmbeddingProgram } from '#/lib/ai/embedding-pin'
import { saveEmbeddingKeyProgram } from '#/lib/ai/providers/embed/settings'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { embedSourceProgram } from '#/lib/ai/embed-source'
import { setValuesEffect } from '@spaces/core/writes/attributes/values'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'

/**
 * SPA-132 (ai-12b): a deal's `close_reason` is an attribute value, so it is
 * chunked through the one write path rather than a bespoke hook. A set
 * through `setValuesEffect` hands the source back as `reembed`, and the
 * caller — the server fn; here, `write` — queues `chunk.embed` with
 * `source_kind: 'attribute'` and `source_key: 'close_reason'` after the write
 * commits (SPA-174/175 moved the enqueue out of core with the write path); a
 * clear deletes the chunks inside the write's own transaction. The job's
 * program is `embedSourceProgram`, run here as the worker runs it (the
 * worker's own outcome mapping is `worker/jobs/embed-source.test.ts`).
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const actor = { type: 'user' as const, id: FIXTURE_ACTOR.id }

async function newRecord(kind: 'deal' | 'company', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
}

const write = async (entityId: string, patch: Record<string, unknown>) => {
  const result = await Effect.runPromise(
    setValuesEffect({ entityId, patch, actor }),
  )
  for (const s of result.reembed) await enqueueSourceEmbed(s)
  return result
}

const runJob = (
  entityId: string,
  sourceKey = 'close_reason',
  model?: MockEmbeddingModelV4,
) =>
  Effect.runPromise(
    embedSourceProgram({
      entityId,
      sourceKind: 'attribute',
      sourceKey,
      ...(model === undefined ? {} : { model }),
    }),
  )

async function chunksOf(entityId: string) {
  return db
    .select({
      text: chunk.text,
      sourceKind: chunk.sourceKind,
      sourceKey: chunk.sourceKey,
      embedding: chunk.embedding,
      embeddingModel: chunk.embeddingModel,
    })
    .from(chunk)
    .where(eq(chunk.entityId, entityId))
    .orderBy(asc(chunk.idx))
}

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings: {} })
    .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
})

describe('close_reason through the one write path', () => {
  it('is the one embeddable attribute, keyed by the deal kind', () => {
    expect(EMBEDDABLE_ATTRIBUTES).toEqual([
      { kind: 'deal', slug: 'close_reason' },
    ])
  })

  it("queues the deal's close_reason as an attribute source after the write commits", async () => {
    const { enqueued } = await import('#/test/queue-stub')
    const deal = await newRecord('deal', 'Coldplate seed')

    const result = await write(deal, {
      close_reason: 'Passed: the team was thin.',
    })

    expect(result.changed).toEqual(['close_reason'])
    expect(enqueued).toEqual([
      {
        name: QUEUES.embedSource,
        data: {
          entityId: deal,
          sourceKind: 'attribute',
          sourceKey: 'close_reason',
        },
        options: { singletonKey: `attribute:close_reason:${deal}` },
      },
    ])
  })

  it('queues nothing for any other attribute, or for a no-op rewrite', async () => {
    const { enqueued } = await import('#/test/queue-stub')
    const deal = await newRecord('deal', 'Other deal')
    const company = await newRecord('company', 'Other co')

    await write(deal, { source: 'inbound' })
    await write(company, { description: 'Makes cold plates.' })
    expect(enqueued).toEqual([])

    await write(deal, { close_reason: 'Lost to a faster fund.' })
    enqueued.length = 0
    await write(deal, { close_reason: 'Lost to a faster fund.' })
    expect(enqueued).toEqual([])
  })

  it('writes null vectors with no pin, replaces on a rewrite, and a clear deletes the chunks', async () => {
    const { enqueued } = await import('#/test/queue-stub')
    const deal = await newRecord('deal', 'Kestrel A')

    await write(deal, { close_reason: 'Passed: too early.' })
    expect(await runJob(deal)).toEqual({
      chunks: 1,
      embeddingModel: null,
      skipped: 'no-pin',
    })
    expect(await chunksOf(deal)).toEqual([
      {
        text: 'Passed: too early.',
        sourceKind: 'attribute',
        sourceKey: 'close_reason',
        embedding: null,
        embeddingModel: null,
      },
    ])

    await write(deal, { close_reason: 'Passed: revisit at Series A.' })
    await runJob(deal)
    expect((await chunksOf(deal)).map((c) => c.text)).toEqual([
      'Passed: revisit at Series A.',
    ])

    enqueued.length = 0
    await write(deal, { close_reason: null })
    // Gone in the clear's own transaction — no job needed, none queued.
    expect(await chunksOf(deal)).toEqual([])
    expect(enqueued).toEqual([])

    // A job that was queued before the clear cuts the empty value: still none.
    await runJob(deal)
    expect(await chunksOf(deal)).toEqual([])
  })

  it('leaves the deal’s other chunk sources alone when the reason is cleared', async () => {
    const deal = await newRecord('deal', 'Two sources')
    await db.insert(chunk).values({
      entityId: deal,
      sourceKind: 'attribute',
      sourceKey: 'some_other_text',
      idx: 0,
      text: 'Not the reason.',
    })
    await write(deal, { close_reason: 'Passed.' })
    await runJob(deal)
    await write(deal, { close_reason: null })

    expect(await chunksOf(deal)).toEqual([
      expect.objectContaining({
        sourceKey: 'some_other_text',
        text: 'Not the reason.',
      }),
    ])
  })

  it('embeds with the pinned model once one is pinned', async () => {
    await Effect.runPromise(
      saveEmbeddingKeyProgram(FIXTURE_ACTOR.id, {
        provider: 'openai',
        key: 'sk-embed-test-0000',
      }),
    )
    await Effect.runPromise(
      pinEmbeddingProgram({
        provider: 'openai',
        model: 'text-embedding-3-small',
      }),
    )
    const model = new MockEmbeddingModelV4({
      provider: 'mock',
      modelId: 'mock-embedding',
      maxEmbeddingsPerCall: 2048,
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() =>
          Array.from({ length: PIN_DIMS }, (_, i) => (i === 0 ? 1 : 0)),
        ),
        usage: { tokens: values.length },
        warnings: [],
      }),
    })
    const deal = await newRecord('deal', 'Pinned deal')
    await write(deal, { close_reason: 'Lost: priced out.' })
    await runJob(deal, 'close_reason', model)

    const c = (await chunksOf(deal)).at(0)
    expect(c?.embeddingModel).toBe('text-embedding-3-small')
    expect(c?.embedding).toHaveLength(PIN_DIMS)
  })
})
