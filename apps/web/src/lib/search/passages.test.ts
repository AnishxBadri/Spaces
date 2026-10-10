import { Effect } from 'effect'
import { MockEmbeddingModelV4 } from 'ai/test'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { chunk, document, entity, link, workspace } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { pinEmbeddingProgram } from '#/lib/ai/embedding-pin'
import { saveEmbeddingKeyProgram } from '#/lib/ai/providers/embed/settings'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { searchPassagesProgram } from './passages'
import { searchAllProgram } from './query'
import { clearQueryEmbeddingCache } from './query-embedding'
import { nameFirst } from './records'

/**
 * Cmd-K's Records and Passages are two lanes, never one list. (D70) The
 * fixture is built so the semantic lane would outrank the record by name:
 * a deck that mentions "halcyon" in its text and whose chunk sits nearest
 * the query. Fused with the vector lane it wins; in the palette it is a
 * passage, and the record typed by name leads Records.
 */

const QUERY = 'halcyon'
const MODEL = 'text-embedding-3-small'

function toward(axis: number) {
  const v = Array.from({ length: PIN_DIMS }, () => 0)
  v[axis] = 1
  return v
}

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

async function newEntity(kind: 'company' | 'document', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
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

const DECK_TEXT =
  'Halcyon-class storage at grid scale, sited beside substations.'

async function fixture() {
  const company = await newEntity('company', 'Halcyon Grid')
  const deck = await newEntity('document', 'Grid storage memo.pdf')
  await db.insert(document).values({
    entityId: deck,
    filename: 'Grid storage memo.pdf',
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: DECK_TEXT,
    tsv: sql`to_tsvector('english', ${DECK_TEXT})`,
  })
  await db
    .insert(link)
    .values({ fromEntityId: deck, toEntityId: company, relation: 'tagged_in' })
  await db.insert(chunk).values({
    entityId: deck,
    sourceKind: 'document',
    sourceKey: '',
    idx: 0,
    text: DECK_TEXT,
    embedding: toward(0),
    embeddingModel: MODEL,
    page: 4,
  })
  return { company, deck }
}

beforeEach(async () => {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings: {} })
    .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
  clearQueryEmbeddingCache()
})

describe('Records and Passages', () => {
  it('puts the record typed by name first in Records, where fused with the vector lane the deck would win', async () => {
    await pin()
    const { company, deck } = await fixture()
    const { model } = countingModel()

    // The fixture is real: the vector lane fused in ranks the deck first.
    const fused = await Effect.runPromise(
      searchAllProgram(
        { userId: FIXTURE_ACTOR.id, q: QUERY, semantic: true },
        { model },
      ),
    )
    expect(fused.at(0)?.id).toBe(deck)

    // The palette's Records: lexical only, a typed name first.
    const records = nameFirst(
      await Effect.runPromise(
        searchAllProgram({ userId: FIXTURE_ACTOR.id, q: QUERY }, { model }),
      ),
      QUERY,
    )
    expect(records.at(0)).toMatchObject({ id: company, matchedIn: 'name' })
    expect(records.every((h) => h.matchedIn !== 'semantic')).toBe(true)

    // The deck is a passage: its page, the record it is filed on.
    const passages = await Effect.runPromise(
      searchPassagesProgram({ userId: FIXTURE_ACTOR.id, q: QUERY }, { model }),
    )
    expect(passages).toEqual([
      {
        id: deck,
        kind: 'document',
        name: 'Grid storage memo.pdf',
        objectSlug: null,
        snippet: DECK_TEXT,
        page: 4,
        parent: {
          id: company,
          kind: 'company',
          name: 'Halcyon Grid',
          // Inserted bare, with no object row.
          objectSlug: null,
        },
      },
    ])
  })

  it('answers no passages and embeds nothing when no model is pinned', async () => {
    await fixture()
    const { model, calls } = countingModel()
    const passages = await Effect.runPromise(
      searchPassagesProgram({ userId: FIXTURE_ACTOR.id, q: QUERY }, { model }),
    )
    expect(passages).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('asks nothing under two characters', async () => {
    await pin()
    const { model, calls } = countingModel()
    const passages = await Effect.runPromise(
      searchPassagesProgram({ userId: FIXTURE_ACTOR.id, q: ' h ' }, { model }),
    )
    expect(passages).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
