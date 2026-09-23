import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { chunk, entity, note } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { JobPermanent } from '../run-job'
import { embedSource, embedSourceData, runEmbedSource } from './embed-source'

/**
 * SPA-132. `chunk.embed`'s wrapper view: the payload it accepts and how the
 * program's outcomes become job outcomes. What the program writes is
 * asserted beside the write paths that queue it
 * (`lib/notes/embed-note.test.ts`, `lib/attributes/embed-close-reason.test.ts`).
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

async function newEntity(kind: 'note' | 'deal', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
}

describe('chunk.embed', () => {
  it('is registered on its own queue, keyed to the source entity for the ledger', () => {
    expect(embedSource.name).toBe(QUEUES.embedSource)
    const id = randomUUID()
    expect(
      embedSource.refs?.({ entityId: id, sourceKind: 'note', sourceKey: '' }),
    ).toEqual({ entityId: id })
  })

  it('accepts a note with an empty key and an attribute with a slug, nothing else', () => {
    const entityId = randomUUID()
    const ok = (data: unknown) => embedSourceData.safeParse(data).success
    expect(ok({ entityId, sourceKind: 'note', sourceKey: '' })).toBe(true)
    expect(
      ok({ entityId, sourceKind: 'attribute', sourceKey: 'close_reason' }),
    ).toBe(true)
    expect(ok({ entityId, sourceKind: 'note', sourceKey: 'body' })).toBe(false)
    expect(ok({ entityId, sourceKind: 'attribute', sourceKey: '' })).toBe(false)
    expect(ok({ entityId, sourceKind: 'document', sourceKey: '' })).toBe(false)
  })

  it('completes with chunks written and no vectors when nothing is pinned', async () => {
    const id = await newEntity('note', 'Call')
    await db.insert(note).values({
      entityId: id,
      title: 'Call',
      bodyMd: 'Liked the team.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
    })

    await Effect.runPromise(
      runEmbedSource({ entityId: id, sourceKind: 'note', sourceKey: '' }),
    )

    const rows = await db
      .select({ embedding: chunk.embedding })
      .from(chunk)
      .where(eq(chunk.entityId, id))
    expect(rows).toEqual([{ embedding: null }])
  })

  it('completes with nothing to do when the source is gone', async () => {
    await Effect.runPromise(
      runEmbedSource({
        entityId: randomUUID(),
        sourceKind: 'attribute',
        sourceKey: 'close_reason',
      }),
    )
    await Effect.runPromise(
      runEmbedSource({
        entityId: randomUUID(),
        sourceKind: 'note',
        sourceKey: '',
      }),
    )
  })

  it('fails permanently on a slug that is not an embeddable attribute', async () => {
    const deal = await newEntity('deal', 'Wrong slug')
    const failure = await Effect.runPromise(
      Effect.flip(
        runEmbedSource({
          entityId: deal,
          sourceKind: 'attribute',
          sourceKey: 'source',
        }),
      ),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toBe(
      'source is not an embeddable attribute of a deal',
    )
    expect(
      await db
        .select({ id: chunk.id })
        .from(chunk)
        .where(eq(chunk.entityId, deal)),
    ).toEqual([])
  })
})
