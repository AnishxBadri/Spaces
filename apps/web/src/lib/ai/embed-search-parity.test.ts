import { Effect } from 'effect'
import { SQL, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { document, entity, link, note, workspace } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { fusedRowsProgram, searchAllProgram } from '#/lib/search/query'
import { pinEmbeddingProgram, readEmbeddingPinProgram } from './embedding-pin'
import { saveEmbeddingKeyProgram } from './providers/embed/settings'

/**
 * SPA-51, acceptance: with no embedding provider configured nothing changes
 * anywhere — and, since this slice adds no vector lane (SPA-129 does),
 * pinning one changes nothing in search either. The statement
 * `fusedRowsProgram` sends is captured off `db.execute` and compiled to its
 * text and parameters, then compared with the pin unset and set, as are
 * the hits a fixture search returns.
 */

const dialect = new PgDialect()

afterEach(() => {
  vi.restoreAllMocks()
})

async function newEntity(kind: 'company' | 'note' | 'document', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
}

async function fixture() {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings: {} })
    .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })

  const company = await newEntity('company', 'Orbital Composites')
  const noteId = await newEntity('note', 'Orbital call')
  await db.insert(note).values({
    entityId: noteId,
    title: 'Orbital call',
    bodyMd: 'Orbital raised a seed round for thermal shielding.',
    authorId: FIXTURE_ACTOR.id,
    visibility: 'shared',
  })
  const text = 'Orbital Composites builds thermal shielding for satellites.'
  const deck = await newEntity('document', 'orbital-deck.pdf')
  await db.insert(document).values({
    entityId: deck,
    filename: 'orbital-deck.pdf',
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: text,
    tsv: sql`to_tsvector('english', ${text})`,
  })
  await db.insert(link).values({
    fromEntityId: deck,
    toEntityId: company,
    relation: 'tagged_in',
  })
}

/** The fused statement as Postgres receives it, and the palette's hits. */
async function observe(q: string) {
  const execute = vi.spyOn(db, 'execute')
  await Effect.runPromise(fusedRowsProgram({ userId: FIXTURE_ACTOR.id, q }))
  const sent = execute.mock.calls.at(0)?.[0]
  execute.mockRestore()
  if (!(sent instanceof SQL)) throw new Error('fusedRowsProgram sent no SQL')
  const statement = dialect.sqlToQuery(sent)
  const hits = await Effect.runPromise(
    searchAllProgram({ userId: FIXTURE_ACTOR.id, q }),
  )
  return { text: statement.sql, params: statement.params, hits }
}

describe('search with and without an embedding pin', () => {
  it('sends the same SQL and returns the same results, pin unset and pin set', async () => {
    await fixture()

    expect(await Effect.runPromise(readEmbeddingPinProgram())).toBeNull()
    const unpinned = await observe('orbital thermal')
    expect(unpinned.hits.length).toBeGreaterThan(0)
    expect(unpinned.text).not.toContain('embedding')

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
    expect(await Effect.runPromise(readEmbeddingPinProgram())).not.toBeNull()

    const pinned = await observe('orbital thermal')
    expect(pinned.text).toBe(unpinned.text)
    expect(pinned.params).toEqual(unpinned.params)
    expect(pinned.hits).toEqual(unpinned.hits)
  })
})
