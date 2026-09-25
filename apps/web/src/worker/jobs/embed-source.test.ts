import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { aiUsage, chunk, entity, note, workspace } from '@spaces/db/schema'
import type { WorkspaceSettings } from '@spaces/db/schema/workspace'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { storeCredential } from '#/lib/vault'
import { fakeOllama } from '#/test/fake-ollama'
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

describe('chunk.embed and the sensitive slot (SPA-83)', () => {
  const PIN = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dims: PIN_DIMS,
    pinned_at: '2026-09-20T00:00:00.000Z',
  }
  const SLOT = {
    provider: 'ollama',
    model: 'nomic-embed-text',
    dims: PIN_DIMS,
    set_at: '2026-09-25T00:00:00.000Z',
  }

  async function setSettings(settings: WorkspaceSettings) {
    await db
      .insert(workspace)
      .values({ id: 1, name: 'Fund', settings })
      .onConflictDoUpdate({ target: workspace.id, set: { settings } })
  }

  /** A sensitive note, and Ollama saved as the Providers section saves it. */
  async function sensitiveNote() {
    await storeCredential({
      scope: 'workspace',
      provider: 'ollama',
      kind: 'llm',
      secret: '',
      keyless: true,
      meta: { baseUrl: 'http://ollama:11434' },
      createdBy: FIXTURE_ACTOR.id,
    })
    const id = await newEntity('note', 'Partner call')
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
    await db.insert(note).values({
      entityId: id,
      title: 'Partner call',
      bodyMd: 'The LP wants out of the fund before the close.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
    })
    return id
  }

  const rowsOf = (id: string) =>
    db
      .select({
        embedding: chunk.embedding,
        model: chunk.embeddingModel,
        sensitive: chunk.sensitive,
      })
      .from(chunk)
      .where(eq(chunk.entityId, id))

  afterEach(async () => {
    vi.unstubAllGlobals()
    await db.delete(aiUsage).where(isNotNull(aiUsage.id))
  })

  it('embeds a sensitive note through the slot and writes its vectors', async () => {
    await setSettings({ embedding: { ...PIN, sensitive: SLOT } })
    const id = await sensitiveNote()
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    await Effect.runPromise(
      runEmbedSource({ entityId: id, sourceKind: 'note', sourceKey: '' }),
    )

    const rows = await rowsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.embedding).toHaveLength(PIN_DIMS)
    expect(rows[0]).toMatchObject({
      model: 'nomic-embed-text',
      sensitive: true,
    })
    expect(ollama.calls.map((c) => c.url)).toEqual([
      'http://ollama:11434/api/embed',
    ])
  })

  it('with no slot, refuses as before: no vectors and no call anywhere', async () => {
    await setSettings({ embedding: PIN })
    const id = await sensitiveNote()
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    await Effect.runPromise(
      runEmbedSource({ entityId: id, sourceKind: 'note', sourceKey: '' }),
    )

    expect(await rowsOf(id)).toEqual([
      { embedding: null, model: null, sensitive: true },
    ])
    expect(ollama.calls).toHaveLength(0)
    expect(await db.select({ id: aiUsage.id }).from(aiUsage)).toEqual([])
  })
})
