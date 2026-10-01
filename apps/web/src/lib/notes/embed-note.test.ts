import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { MockEmbeddingModelV4 } from 'ai/test'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  chunk,
  document,
  entity,
  link,
  note,
  workspace,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { embedDocumentProgram } from '#/lib/ai/embed-document'
import { pinEmbeddingProgram } from '#/lib/ai/embedding-pin'
import { saveEmbeddingKeyProgram } from '#/lib/ai/providers/embed/settings'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { assembleProgram } from '@spaces/core/writes/context/assemble'
import { SimilarLaneLive } from '#/lib/ai/similar'
import { searchAllProgram } from '#/lib/search/query'
import { clearQueryEmbeddingCache } from '#/lib/search/query-embedding'
import { canRead } from '@spaces/core/read-policy'
import { embedSourceProgram, noteEmbedText } from '#/lib/ai/embed-source'
import { saveNoteProgram } from './save'

/**
 * SPA-132 (ai-12b): notes embed on save. `saveNoteProgram` queues
 * `chunk.embed` once its write commits; the job's program
 * (`embedSourceProgram`, run here as the worker runs it) replaces the note's chunks through the same
 * replace-stamp-embed transaction documents use. The embedding wire is a
 * fake chosen per text through `embed()`'s `model` seam, so the pin, the
 * width check and the `ai_usage` row are real and "nearest" is decided by
 * the fixture.
 *
 * The search half calls `searchAllProgram` read-only — this slice changes no
 * file under `lib/search/`, and these tests are the proof that the unchanged
 * query reaches the new source: a note found by meaning, beside a deck, and
 * a teammate's private note kept out by `canReadNoteSql` although its chunk
 * is the nearest of all.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const MODEL = 'text-embedding-3-small'
const QUERY = 'why did we walk away from the thermal startup'
const ASOF = '2026-09-23T00:00:00Z'

function toward(axis: number, lean?: { axis: number; by: number }) {
  const v = Array.from({ length: PIN_DIMS }, () => 0)
  v[axis] = 1
  if (lean) v[lean.axis] = lean.by
  return v
}

/**
 * The fake provider. The query sits on axis 0; a text carrying one of these
 * markers sits at the chosen distance from it; anything else far away.
 */
const PLACES: Array<[string, Array<number>]> = [
  ['PRIVATE-DOUBT', toward(0)],
  ['REFERENCE-CALLS', toward(0, { axis: 2, by: 0.15 })],
  ['DRY-COOLER', toward(0, { axis: 3, by: 0.3 })],
]
function placingModel() {
  return new MockEmbeddingModelV4({
    provider: 'mock',
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) =>
        v === QUERY
          ? toward(0)
          : (PLACES.find(([mark]) => v.includes(mark))?.[1] ?? toward(700)),
      ),
      usage: { tokens: values.length },
      warnings: [],
    }),
  })
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

async function newEntity(kind: 'note' | 'document' | 'deal', name: string) {
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
      })
      .returning({ id: user.id })
  ).at(0)
  if (!row) throw new Error('user insert returned nothing')
  return row.id
}

/** An empty note, as `createNote` leaves one. */
async function newNote(authorId: string, visibility: 'shared' | 'private') {
  const id = await newEntity('note', 'Untitled')
  await db
    .insert(note)
    .values({ entityId: id, title: '', bodyMd: '', authorId, visibility })
  return id
}

const save = (userId: string, id: string, title: string, bodyMd: string) =>
  Effect.runPromise(
    saveNoteProgram(userId, {
      id,
      title,
      body: { bodyJson: [], bodyMd, mentionIds: [] },
    }),
  )

const runJob = (entityId: string, model?: MockEmbeddingModelV4) =>
  Effect.runPromise(
    embedSourceProgram({
      entityId,
      sourceKind: 'note',
      sourceKey: '',
      ...(model === undefined ? {} : { model }),
    }),
  )

async function noteChunks(entityId: string) {
  return db
    .select({
      idx: chunk.idx,
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

/** A deck through the real document writer. */
async function chunkedDeck(filename: string, text: string) {
  const id = await newEntity('document', filename)
  await db.insert(document).values({
    entityId: id,
    filename,
    mime: 'text/plain',
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: text,
  })
  await Effect.runPromise(
    embedDocumentProgram({ documentId: id, model: placingModel() }),
  )
  return id
}

const search = (userId: string) =>
  Effect.runPromise(
    searchAllProgram(
      { userId, q: QUERY, semantic: true },
      { model: placingModel() },
    ),
  )

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
  clearQueryEmbeddingCache()
  // Unpinned unless a describe pins: the settings row is file state.
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings: {} })
    .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
})

describe('noteEmbedText', () => {
  it("cuts the editor's Mentions trailer and leads with the title", () => {
    expect(
      noteEmbedText(
        'Call with Acme',
        'They want a lead by March.\n\nMentions: [[Acme|entity:0f0e]] [[Jo|entity:1a1b]]\n',
      ),
    ).toBe('Call with Acme\n\nThey want a lead by March.')
    // Mid-note prose that says "Mentions:" keeps its words.
    expect(noteEmbedText('', 'Mentions: none so far.\nMore to come.')).toBe(
      'Mentions: none so far.\nMore to come.',
    )
    expect(noteEmbedText('  ', 'Mentions: [[Acme|entity:0f0e]]')).toBe('')
  })
})

describe('embed on note save, unpinned', () => {
  it('queues the note after the save commits, and a burst of saves is one queued job', async () => {
    const { enqueued } = await import('#/test/queue-stub')
    const id = await newNote(FIXTURE_ACTOR.id, 'shared')

    await save(FIXTURE_ACTOR.id, id, 'First call', 'Liked the team.')
    await save(FIXTURE_ACTOR.id, id, 'First call', 'Liked the team a lot.')

    expect(enqueued).toEqual([
      {
        name: QUEUES.embedSource,
        data: { entityId: id, sourceKind: 'note', sourceKey: '' },
        options: { singletonKey: `note::${id}` },
      },
    ])
  })

  it('writes null vectors with no pin, and a re-save replaces the chunks rather than appending', async () => {
    const id = await newNote(FIXTURE_ACTOR.id, 'shared')

    await save(
      FIXTURE_ACTOR.id,
      id,
      'First call',
      'Liked the team.\n\nMentions: [[Acme|entity:0f0e]]\n',
    )
    await runJob(id)
    const first = await noteChunks(id)
    expect(first).toEqual([
      {
        idx: 0,
        text: 'First call\n\nLiked the team.',
        sourceKind: 'note',
        sourceKey: '',
        embedding: null,
        embeddingModel: null,
      },
    ])

    await save(FIXTURE_ACTOR.id, id, 'Second call', 'Passed on price.')
    await runJob(id)
    await runJob(id) // a retry of the same job: still one cut
    expect((await noteChunks(id)).map((c) => c.text)).toEqual([
      'Second call\n\nPassed on price.',
    ])

    // Emptied: the note keeps no chunks.
    await save(FIXTURE_ACTOR.id, id, '', '')
    await runJob(id)
    expect(await noteChunks(id)).toEqual([])
  })

  it('chunks a private note like any other', async () => {
    const other = await teammate()
    const id = await newNote(other, 'private')
    await save(other, id, 'Scratch', 'Doubts about the founders.')
    await runJob(id)
    expect((await noteChunks(id)).map((c) => c.text)).toEqual([
      'Scratch\n\nDoubts about the founders.',
    ])
  })
})

describe('embed on note save, pinned', () => {
  beforeEach(pin)

  it('embeds with the pinned model, and semantic search finds the note by meaning beside a deck', async () => {
    const deck = await chunkedDeck(
      'Coldplate Series A.txt',
      'DRY-COOLER loop: warm water leaves the hall with no chillers at all.',
    )
    const mine = await newNote(FIXTURE_ACTOR.id, 'shared')
    await save(
      FIXTURE_ACTOR.id,
      mine,
      'Pass memo',
      'REFERENCE-CALLS came back lukewarm on the CTO.',
    )
    await runJob(mine, placingModel())

    const c = (await noteChunks(mine)).at(0)
    expect(c?.embeddingModel).toBe(MODEL)
    expect(c?.embedding).toHaveLength(PIN_DIMS)

    const hits = await search(FIXTURE_ACTOR.id)
    expect(hits.find((h) => h.id === mine)).toMatchObject({
      kind: 'note',
      matchedIn: 'semantic',
    })
    expect(hits.find((h) => h.id === deck)).toMatchObject({
      kind: 'document',
      matchedIn: 'semantic',
    })
    // Nearer first: the note sits closer to the query than the deck.
    const ids = hits.map((h) => h.id)
    expect(ids.indexOf(mine)).toBeLessThan(ids.indexOf(deck))
  })

  it("keeps a teammate's private note out of a semantic search that would otherwise rank it first", async () => {
    const other = await teammate()
    const theirs = await newNote(other, 'private')
    await save(
      other,
      theirs,
      'Scratch',
      'PRIVATE-DOUBT: the founders are not ready.',
    )
    await runJob(theirs, placingModel())
    const mine = await newNote(FIXTURE_ACTOR.id, 'shared')
    await save(
      FIXTURE_ACTOR.id,
      mine,
      'Pass memo',
      'REFERENCE-CALLS came back lukewarm on the CTO.',
    )
    await runJob(mine, placingModel())

    // The chunk exists, and is the nearest of all.
    expect(await noteChunks(theirs)).toHaveLength(1)
    const theirHits = await search(other)
    expect(theirHits.at(0)?.id).toBe(theirs)

    const myIds = (await search(FIXTURE_ACTOR.id)).map((h) => h.id)
    expect(myIds).toContain(mine)
    expect(myIds).not.toContain(theirs)
  })
})

describe('the assembler over chunked notes', () => {
  it("never lets a teammate's chunked private note reach the other user; ContextLeak's invariant holds on every item", async () => {
    const other = await teammate()
    const deal = await newEntity('deal', 'Coldplate seed')
    const deck = await chunkedDeck(
      'Coldplate teaser.txt',
      'DRY-COOLER loop: warm water leaves the hall with no chillers at all.',
    )
    const theirs = await newNote(other, 'private')
    await save(other, theirs, 'Scratch', 'PRIVATE-DOUBT: not ready.')
    await runJob(theirs)
    const shared = await newNote(FIXTURE_ACTOR.id, 'shared')
    await save(FIXTURE_ACTOR.id, shared, 'Call', 'REFERENCE-CALLS were fine.')
    await runJob(shared)
    await db.insert(link).values([
      { fromEntityId: theirs, toEntityId: deal, relation: 'mentions' },
      { fromEntityId: shared, toEntityId: deal, relation: 'mentions' },
      { fromEntityId: deck, toEntityId: deal, relation: 'tagged_in' },
    ])
    // Every source is chunked: the deck, the shared note, the private one.
    const chunked = await db
      .selectDistinct({ id: chunk.entityId })
      .from(chunk)
      .where(inArray(chunk.entityId, [deck, shared, theirs]))
    expect(chunked).toHaveLength(3)

    const assemble = (userId: string) =>
      Effect.runPromise(
        assembleProgram(
          { entityId: deal },
          {
            user: { id: userId },
            asOf: ASOF,
            budgetChars: 20_000,
            taskText: 'founders not ready chillers',
          },
        ).pipe(Effect.provide(SimilarLaneLive)),
      )

    const mine = await assemble(FIXTURE_ACTOR.id)
    expect(mine.items.some((i) => i.kind === 'doc_chunk')).toBe(true)
    expect(mine.items.some((i) => i.entityIds.includes(shared))).toBe(true)
    expect(mine.items.some((i) => i.entityIds.includes(theirs))).toBe(false)
    expect(mine.items.some((i) => i.text.includes('PRIVATE-DOUBT'))).toBe(false)

    // The invariant, re-run from outside against the rows themselves: every
    // note an item names — chunk-sourced items included — is one this user
    // may read.
    const named = [...new Set(mine.items.flatMap((i) => i.entityIds))]
    const notes = await db
      .select({
        entityId: note.entityId,
        authorId: note.authorId,
        visibility: note.visibility,
      })
      .from(note)
      .where(inArray(note.entityId, named))
    expect(notes.length).toBeGreaterThan(0)
    for (const n of notes)
      expect(canRead({ id: FIXTURE_ACTOR.id }, n)).toBe(true)

    // Its author does get it.
    const theirsView = await assemble(other)
    expect(theirsView.items.some((i) => i.entityIds.includes(theirs))).toBe(
      true,
    )
    // …and the chunks were never withheld from the table.
    expect(
      await db
        .select({ id: chunk.id })
        .from(chunk)
        .where(and(eq(chunk.entityId, theirs), eq(chunk.sourceKind, 'note'))),
    ).toHaveLength(1)
  })
})
