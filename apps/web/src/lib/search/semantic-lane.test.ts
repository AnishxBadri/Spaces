import { randomUUID } from 'node:crypto'
import { Effect, Logger } from 'effect'
import { MockEmbeddingModelV4 } from 'ai/test'
import { SQL, count, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  chunk,
  document,
  entity,
  link,
  note,
  workspace,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { pinEmbeddingProgram } from '#/lib/ai/embedding-pin'
import { saveEmbeddingKeyProgram } from '#/lib/ai/providers/embed/settings'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { recordPath } from '../record-path'
import { fusedStatement, searchAllProgram } from './query'
import { clearQueryEmbeddingCache } from './query-embedding'

/**
 * The semantic lane (SPA-129) — the fifth CTE of Cmd-K's fused query, and
 * the palette's second wave. The embedding wire is a counting fake
 * (`MockEmbeddingModelV4` through `embed()`'s `model` seam), so the pin, the
 * cap and the `ai_usage` row are real and every provider call is counted.
 * Chunks are written by hand with chosen vectors: the query "heat rejection
 * in racks" embeds to one axis, and each fixture chunk sits at a chosen
 * distance from it, so "nearest" is decided by the fixture, not by a model.
 *
 * The file's database was truncated and reseeded before it was imported
 * (SPA-145), so these fixtures are the whole corpus and the pin set here
 * reaches no other file.
 */

const dialect = new PgDialect()
const QUERY = 'heat rejection in racks'
const MODEL = 'text-embedding-3-small'

/** A 768-wide vector pointing mostly along `axis`, a little along `lean`. */
function toward(axis: number, lean?: { axis: number; by: number }) {
  const v = Array.from({ length: PIN_DIMS }, () => 0)
  v[axis] = 1
  if (lean) v[lean.axis] = lean.by
  return v
}

/** The fake provider: the query lands on axis 0; anything else on axis 700. */
function countingModel() {
  const calls: Array<ReadonlyArray<string>> = []
  const model = new MockEmbeddingModelV4({
    provider: 'mock',
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => {
      calls.push(values)
      return {
        embeddings: values.map((v) => (v === QUERY ? toward(0) : toward(700))),
        usage: { tokens: 4 },
        warnings: [],
      }
    },
  })
  return { model, calls }
}

async function setSettings(settings: typeof workspace.$inferInsert.settings) {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

async function pin() {
  await Effect.runPromise(
    saveEmbeddingKeyProgram(FIXTURE_ACTOR.id, {
      provider: 'openai',
      key: 'sk-embed-test-0000',
    }),
  )
  await Effect.runPromise(
    pinEmbeddingProgram({ provider: 'openai', model: MODEL }),
  )
}

async function newEntity(
  kind: 'company' | 'note' | 'document' | 'deal',
  name: string,
) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
}

async function teammate() {
  const row = (
    await db
      .insert(user)
      .values({
        id: randomUUID(),
        name: 'Other Partner',
        email: `${randomUUID()}@fund.example`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: user.id })
  ).at(0)
  if (!row) throw new Error('user insert returned nothing')
  return row.id
}

/** A deck as extraction leaves it; its chunks are written separately. */
async function newDeck(filename: string, text: string) {
  const id = await newEntity('document', filename)
  await db.insert(document).values({
    entityId: id,
    filename,
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: text,
    tsv: sql`to_tsvector('english', ${text})`,
  })
  return id
}

async function newNote(opts: {
  title: string
  body: string
  authorId: string
  visibility: 'shared' | 'private'
}) {
  const id = await newEntity('note', opts.title)
  await db.insert(note).values({
    entityId: id,
    title: opts.title,
    bodyMd: opts.body,
    authorId: opts.authorId,
    visibility: opts.visibility,
  })
  return id
}

/** One `chunk` row, written by hand as a future embed job would write it. */
async function newChunk(opts: {
  entityId: string
  sourceKind: 'document' | 'note' | 'attribute'
  text: string
  embedding: Array<number>
  embeddingModel?: string
  idx?: number
}) {
  await db.insert(chunk).values({
    entityId: opts.entityId,
    sourceKind: opts.sourceKind,
    sourceKey: opts.sourceKind === 'attribute' ? 'close_reason' : '',
    idx: opts.idx ?? 0,
    text: opts.text,
    embedding: opts.embedding,
    embeddingModel: opts.embeddingModel ?? MODEL,
  })
}

const search = (
  q: string,
  opts: { semantic?: boolean; userId?: string } = {},
  model?: MockEmbeddingModelV4,
) =>
  Effect.runPromise(
    searchAllProgram(
      {
        userId: opts.userId ?? FIXTURE_ACTOR.id,
        q,
        semantic: opts.semantic ?? true,
      },
      model === undefined ? {} : { model },
    ),
  )

/** The statement a search sent, as text, and the hits it answered. */
async function observe(
  q: string,
  opts: { semantic: boolean },
  model?: MockEmbeddingModelV4,
) {
  const execute = vi.spyOn(db, 'execute')
  const hits = await search(q, opts, model)
  const sent = execute.mock.calls.at(0)?.[0]
  execute.mockRestore()
  if (!(sent instanceof SQL)) throw new Error('the search sent no SQL')
  return { text: dialect.sqlToQuery(sent).sql, hits }
}

async function usageRows() {
  const rows = await db.select({ value: count() }).from(aiUsage)
  return rows.at(0)?.value ?? 0
}

/** The cooling deck: none of the query's words appear in it. */
const COOLING_TEXT =
  'Our «direct-to-chip» liquid loop moves thermal load off the server floor. ' +
  'Cold plates sit on each accelerator and the warm water leaves the building ' +
  'through a dry cooler, so the hall needs no chillers even in a hot summer.'

async function coolingDeck() {
  const company = await newEntity('company', 'Coldplate Systems')
  const deck = await newDeck('Coldplate Series A.pdf', COOLING_TEXT)
  await db
    .insert(link)
    .values({ fromEntityId: deck, toEntityId: company, relation: 'tagged_in' })
  await newChunk({
    entityId: deck,
    sourceKind: 'document',
    text: COOLING_TEXT,
    embedding: toward(0, { axis: 1, by: 0.2 }),
  })
  return { company, deck }
}

beforeEach(async () => {
  await setSettings({})
  clearQueryEmbeddingCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the semantic lane, unpinned', () => {
  it('emits no vector CTE and calls no model: the second wave is the lexical statement', async () => {
    await coolingDeck()
    const { model, calls } = countingModel()

    const lexical = await observe('coldplate', { semantic: false }, model)
    const second = await observe('coldplate', { semantic: true }, model)

    for (const text of [lexical.text, second.text]) {
      expect(text).not.toContain('sem_hits')
      expect(text).not.toContain('<=>')
      expect(text).not.toMatch(/from chunk\b/)
    }
    expect(second.text).toBe(lexical.text)
    expect(second.hits).toEqual(lexical.hits)
    expect(calls).toHaveLength(0)
    expect(await usageRows()).toBe(0)
  })
})

describe('the semantic lane, pinned', () => {
  beforeEach(pin)

  it('finds a deck by meaning when none of the words are in it, and routes it to its record', async () => {
    const { company, deck } = await coolingDeck()
    const other = await newDeck(
      'Fintech seed deck.pdf',
      'Card issuing for regional lenders.',
    )
    await newChunk({
      entityId: other,
      sourceKind: 'document',
      text: 'Card issuing for regional lenders.',
      embedding: toward(9),
    })
    const { model } = countingModel()

    // The words are nowhere: the lexical wave cannot find it.
    const lexical = await search(QUERY, { semantic: false }, model)
    expect(lexical.map((h) => h.id)).not.toContain(deck)

    const hits = await search(QUERY, {}, model)
    const hit = hits.find((h) => h.id === deck)
    expect(hit).toMatchObject({
      rowKind: 'entity',
      kind: 'document',
      matchedIn: 'semantic',
      parent: { id: company, kind: 'company', name: 'Coldplate Systems' },
      task: null,
    })
    // Nearest first: the cooling deck outranks the fintech one.
    expect(hits.map((h) => h.id).indexOf(deck)).toBeLessThan(
      hits.map((h) => h.id).indexOf(other),
    )
    if (!hit?.parent) throw new Error('the deck resolved no parent')
    expect(recordPath(hit.parent)).toBe(`/companies/${company}`)

    // A plain 160-character cut of the nearest chunk: nothing matched a
    // word, so nothing is marked — the « » in the source text are dropped.
    expect(hit.snippet).toHaveLength(160)
    expect(hit.snippet).not.toMatch(/[«»]/)
    expect(hit.snippet).toBe(
      COOLING_TEXT.replace(/[«»]/g, '').replace(/\s+/g, ' ').slice(0, 160),
    )
  })

  it('reaches a note-sourced chunk through the unchanged query — source_kind is never filtered', async () => {
    const id = await newNote({
      title: 'Site visit',
      body: 'Walked the data hall with the facilities lead.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
    })
    await newChunk({
      entityId: id,
      sourceKind: 'note',
      text: 'The hall runs warm-water cooling; the CRAH units are gone.',
      embedding: toward(0, { axis: 2, by: 0.1 }),
    })
    const deal = await newEntity('deal', 'Coldplate seed')
    await newChunk({
      entityId: deal,
      sourceKind: 'attribute',
      text: 'Passed: the thermal story was strong but the team was thin.',
      embedding: toward(0, { axis: 3, by: 0.3 }),
    })
    const { model } = countingModel()

    const hits = await search(QUERY, {}, model)

    expect(hits.find((h) => h.id === id)).toMatchObject({
      kind: 'note',
      matchedIn: 'semantic',
    })
    expect(hits.find((h) => h.id === deal)).toMatchObject({
      kind: 'deal',
      matchedIn: 'semantic',
    })
  })

  it("never returns a teammate's private note by meaning, and does return the searcher's own", async () => {
    const other = await teammate()
    const theirs = await newNote({
      title: 'Diligence scratch',
      body: 'Thoughts on the founders.',
      authorId: other,
      visibility: 'private',
    })
    const mine = await newNote({
      title: 'My scratch',
      body: 'Thoughts on the market.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'private',
    })
    // Theirs is the nearest chunk of all: only canRead can keep it out.
    await newChunk({
      entityId: theirs,
      sourceKind: 'note',
      text: 'Their cooling thesis.',
      embedding: toward(0),
    })
    await newChunk({
      entityId: mine,
      sourceKind: 'note',
      text: 'My cooling thesis.',
      embedding: toward(0, { axis: 4, by: 0.2 }),
    })
    const { model } = countingModel()

    const ids = (await search(QUERY, {}, model)).map((h) => h.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)

    const theirIds = (await search(QUERY, { userId: other }, model)).map(
      (h) => h.id,
    )
    expect(theirIds).toContain(theirs)
    expect(theirIds).not.toContain(mine)
  })

  it('skips a chunk embedded by another model even when its vector is the closest', async () => {
    const { deck } = await coolingDeck()
    const stale = await newDeck('Old immersion deck.pdf', 'Immersion tanks.')
    await newChunk({
      entityId: stale,
      sourceKind: 'document',
      text: 'Immersion tanks.',
      embedding: toward(0),
      embeddingModel: 'text-embedding-ada-002',
    })
    const { model } = countingModel()

    const ids = (await search(QUERY, {}, model)).map((h) => h.id)
    expect(ids).toContain(deck)
    expect(ids).not.toContain(stale)
  })

  it('embeds a phrase once per (text, model), and the per-keystroke wave embeds nothing', async () => {
    await coolingDeck()
    const { model, calls } = countingModel()
    const before = await usageRows()

    // Every keystroke of the phrase, as the lexical wave sends them.
    for (let n = 2; n <= QUERY.length; n++)
      await search(QUERY.slice(0, n), { semantic: false }, model)
    expect(calls).toHaveLength(0)
    expect(await usageRows()).toBe(before)

    // The second wave, twice on the same phrase: one provider call.
    await search(QUERY, {}, model)
    await search(QUERY, {}, model)
    expect(calls).toEqual([[QUERY]])
    expect(await usageRows()).toBe(before + 1)

    // Another phrase is another call.
    await search('liquid cooling', {}, model)
    expect(calls).toHaveLength(2)
  })

  it('falls back to the lexical answer when the embed fails, and logs it once', async () => {
    const { deck } = await coolingDeck()
    await setSettings({
      embedding: {
        provider: 'openai',
        model: MODEL,
        dims: PIN_DIMS,
        pinned_at: '2026-09-23T00:00:00.000Z',
      },
      ai_caps: { per_run_tokens: 1 },
    })
    const { model, calls } = countingModel()
    const warnings: Array<unknown> = []
    const capture = Logger.layer([
      Logger.make((o) => {
        if (o.logLevel === 'Warn') warnings.push(o.message)
      }),
    ])
    const second = (q: string) =>
      Effect.runPromise(
        searchAllProgram(
          { userId: FIXTURE_ACTOR.id, q, semantic: true },
          { model },
        ).pipe(Effect.provide(capture)),
      )

    const lexical = await search('coldplate', { semantic: false }, model)
    expect(lexical.map((h) => h.id)).toContain(deck)

    expect(await second('coldplate')).toEqual(lexical)
    expect(await second('coldplate series')).toEqual(
      await search('coldplate series', { semantic: false }, model),
    )
    expect(calls).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0])).toContain('CapExceeded')
  })

  it('adds exactly one lane: the statement names sem_hits once in the union, k = 60 once, and groups on (row_kind, id)', async () => {
    await coolingDeck()
    const { model } = countingModel()

    const { text } = await observe(QUERY, { semantic: true }, model)

    expect(text.match(/from sem_hits/g)).toHaveLength(1)
    expect(text.match(/union all/g)).toHaveLength(4)
    expect(text.match(/\b60 \+/g)).toHaveLength(1)
    expect(text).toContain('group by f.row_kind, f.id')
    expect(text.match(/limit 40\b/g)).toHaveLength(5)
    expect(text).toContain('order by ch.embedding <=> (select v from qv)')
  })

  it('walks the HNSW index for the semantic CTE (EXPLAIN)', async () => {
    await coolingDeck()
    // A few hundred rows so the plan is not decided by an empty table. At
    // this size the planner still prefers a sequential scan (verified: it
    // picks `Seq Scan on chunk` with seq scans allowed), so the EXPLAIN
    // turns them off for its own transaction only — the question asked is
    // whether the CTE's shape lets the index serve it, not what a 300-row
    // table costs.
    const filler = await newEntity('document', 'filler.pdf')
    await db.insert(chunk).values(
      Array.from({ length: 300 }, (_, i) => ({
        entityId: filler,
        sourceKind: 'document' as const,
        sourceKey: '',
        idx: i,
        text: `filler ${i}`,
        embedding: toward(10 + (i % 700)),
        embeddingModel: MODEL,
      })),
    )
    await db.execute(sql`analyze chunk`)

    const statement = fusedStatement({
      userId: FIXTURE_ACTOR.id,
      q: QUERY,
      vector: { vector: toward(0), model: MODEL },
    })
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`)
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain ${statement}`,
      )
      return rows.rows.map((r) => r['QUERY PLAN']).join('\n')
    })

    // The index walks in distance order from the query vector, handed over
    // as an init-plan constant; the model filter applies above its limit.
    expect(plan).toMatch(/Index Scan using chunk_embedding_hnsw_idx on chunk/)
    expect(plan).toMatch(/Order By: \(embedding <=> \(InitPlan \d+\)\.col1\)/)
    expect(plan).toMatch(/Filter: \(c\.embedding_model = /)
  })
})
