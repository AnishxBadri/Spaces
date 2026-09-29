import { randomUUID } from 'node:crypto'
import { BlockNoteEditor } from '@blocknote/core'
import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { count, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  chunk,
  document,
  entity,
  link,
  note,
  suggestion,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { readNotePayload } from '@spaces/core/ai/note'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { jsonValue } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  blocksToMarkdown,
  noteBodyFromMarkdown,
} from '#/lib/notes/markdown-blocks'
import { editorBlocks } from '#/test/note-blocks'
import {
  NO_DEAL,
  enqueueKeyTermsProgram,
  keyTermsMessage,
  keyTermsProgram,
  keyTermsStatusOf,
  keyTermsStatusProgram,
} from './key-terms'
import { acceptProgram } from './propose'
import { clearAiRouteProgram, setAiRouteProgram } from './route'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-91. Extract key terms through an injected model
 * (`MockLanguageModelV4`, as the deck reader's tests): the route, the
 * sensitivity read, the extraction cache, the citation labels and the
 * suggestion row are real; nothing reaches a network.
 */

const PROPOSER = FIXTURE_ACTOR.id
const ACCEPTER = {
  id: 'spa91-accepter',
  name: 'Accepter',
  email: 'accepter-spa91@spaces.test',
  emailVerified: true,
}

type Answer = Record<string, { value: unknown; refs: Array<string> } | null>

/** A structured-output model: answers `answer(prompt)` as JSON. */
function mockModel(answer: (prompt: string) => Answer) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify(answer(JSON.stringify(options.prompt))),
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      }),
  })
}

async function routeExtract() {
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

async function deal(name = 'Acme Series A') {
  const [row] = await db
    .insert(entity)
    .values({
      kind: 'deal',
      canonicalName: `${name} ${randomUUID().slice(0, 8)}`,
    })
    .returning({ id: entity.id })
  return row.id
}

async function company() {
  const tag = randomUUID().slice(0, 8)
  const c = await resolveEntity({
    kind: 'company',
    name: `Acme ${tag}`,
    keys: { domain: `acme-${tag}.example` },
    source: { class: 'manual' },
  })
  return c.entityId
}

/** A term sheet, chunked with real pages, filed on each of `on`. */
async function termSheet(
  on: Array<string>,
  kind: 'legal' | 'dd' | 'article' = 'legal',
) {
  const tag = randomUUID().slice(0, 8)
  const filename = `term_sheet_${tag}.pdf`
  const [docEnt] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: filename })
    .returning({ id: entity.id })
  // A fixture wanting a document already extracted — the state the button
  // appears in.
  await db.insert(document).values({
    entityId: docEnt.id,
    filename,
    kind,
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: 'Series A term sheet.',
  })
  await db.insert(chunk).values(
    [
      { text: 'Investment: $5M Series A preferred.', page: 1 },
      {
        text: 'Liquidation preference: 1x non-participating. Pro-rata for Major Investors.',
        page: 2,
      },
      { text: 'Board: two founders, one investor director.', page: 3 },
      { text: 'Governed by the laws of England and Wales.', page: 7 },
    ].map((c, idx) => ({
      entityId: docEnt.id,
      sourceKind: 'document' as const,
      idx,
      text: c.text,
      page: c.page,
    })),
  )
  for (const id of on)
    await db.insert(link).values({
      fromEntityId: docEnt.id,
      toEntityId: id,
      relation: 'tagged_in',
      source: 'manual',
    })
  return { documentId: docEnt.id, filename }
}

const ANSWER = (documentId: string): Answer => ({
  governing_law: {
    value: 'England and Wales',
    refs: [`doc:${documentId}#3`],
  },
  liquidation_preference: {
    value: '1x non-participating',
    refs: [`doc:${documentId}#1`],
  },
  pro_rata: { value: 'Major Investors', refs: [`doc:${documentId}#1`] },
  board_composition: {
    value: 'Two founders | one investor director',
    refs: [`doc:${documentId}#2`, `doc:${documentId}#99`],
  },
  // Filled although told not to: absent, not a "not found" row.
  exclusivity: { value: 'Not found', refs: [`doc:${documentId}#0`] },
  information_rights: null,
  // Citing only what the context never carried: no row.
  anti_dilution: { value: 'Broad-based', refs: [`doc:${documentId}#42`] },
})

const usageCount = async () =>
  (await db.select({ value: count() }).from(aiUsage))[0].value

function stored(doc: unknown): Array<Json> {
  const round = jsonValue.parse(JSON.parse(JSON.stringify(doc)))
  return Array.isArray(round) ? round : []
}

/** BlockNote mints an id per block on load; strip them to compare shape. */
function withoutIds(blocks: Array<Json>): Array<Json> {
  return blocks.map((b) => {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return b
    const { id: _id, children, ...rest } = b
    return {
      ...rest,
      children: Array.isArray(children) ? withoutIds(children) : [],
    }
  })
}

beforeEach(async () => {
  enqueued.length = 0
  await db.insert(user).values(ACCEPTER).onConflictDoNothing()
})

describe('keyTermsProgram', () => {
  it('proposes one note on the deal whose body is a term / value / citation table, every row cited', async () => {
    await routeExtract()
    const dealId = await deal()
    const { documentId, filename } = await termSheet([dealId])
    const model = mockModel(() => ANSWER(documentId))

    const result = await Effect.runPromise(
      keyTermsProgram({ documentId, userId: PROPOSER, model }),
    )
    expect(result.terms).toBe(4)
    expect(result.suggestions).toHaveLength(1)
    const s = result.suggestions[0]
    expect(s.kind).toBe('note')
    expect(s.entityId).toBe(dealId)
    expect(s.status).toBe('open')

    // The document's pages lead the prompt, each under its own ref.
    expect(model.doGenerateCalls).toHaveLength(1)
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain(`[doc:${documentId}#3] ${filename} p.7`)

    const payload = readNotePayload(s.payload)
    if (!payload) throw new Error('no note payload')
    expect(payload.sourceId).toBe(documentId)
    expect(payload.title).toBe(`Key terms: ${filename}`)
    const file = filename.replace(/_/g, '\\_')
    expect(payload.markdown).toBe(
      [
        '| Term | Value | Citation |',
        '| --- | --- | --- |',
        `| Liquidation preference | 1x non-participating | ${file}, p.2 |`,
        `| Pro-rata | Major Investors | ${file}, p.2 |`,
        `| Board composition | Two founders \\| one investor director | ${file}, p.3 |`,
        `| Governing law | England and Wales | ${file}, p.7 |`,
      ].join('\n'),
    )
    // Unmentioned terms are absent, never "not found".
    expect(payload.markdown).not.toMatch(/not found/i)
    expect(payload.markdown).not.toContain('Exclusivity')
    expect(payload.markdown).not.toContain('Anti-dilution')
    expect(payload.markdown).not.toContain('Information rights')
    expect(s.refs).toEqual([
      `doc:${documentId}#1`,
      `doc:${documentId}#2`,
      `doc:${documentId}#3`,
    ])
    expect(s.rationale).toMatch(/1 term was left out for citing nothing/)
  })

  it('accepting writes a shared note on the deal that opens as a table, and writes no field', async () => {
    await routeExtract()
    const dealId = await deal()
    const { documentId, filename } = await termSheet([dealId])
    const { suggestions } = await Effect.runPromise(
      keyTermsProgram({
        documentId,
        userId: PROPOSER,
        model: mockModel(() => ANSWER(documentId)),
      }),
    )
    const accepted = await Effect.runPromise(
      acceptProgram(suggestions[0].id, { type: 'user', id: ACCEPTER.id }),
    )
    if (accepted.kind !== 'note') throw new Error('expected a note accept')

    const row = (
      await db.select().from(note).where(eq(note.entityId, accepted.noteId))
    ).at(0)
    if (!row) throw new Error('no note row')
    expect(row.title).toBe(`Key terms: ${filename}`)
    expect(row.visibility).toBe('shared')
    expect(row.bodyMd).toContain('| Liquidation preference |')

    const edges = await db
      .select({ to: link.toEntityId, relation: link.relation })
      .from(link)
      .where(eq(link.fromEntityId, accepted.noteId))
    expect(edges).toEqual(
      expect.arrayContaining([
        { to: dealId, relation: 'tagged_in' },
        { to: documentId, relation: 'derived_from' },
      ]),
    )

    // The body is one BlockNote table: the renderer's blocks for the
    // payload, exactly, and they open in the editor as themselves.
    const rendered = noteBodyFromMarkdown(
      readNotePayload(suggestions[0].payload)?.markdown ?? '',
    ).bodyJson
    expect(row.bodyJson).toEqual(stored(rendered))
    const editor = BlockNoteEditor.create({
      initialContent: editorBlocks(rendered),
    })
    const opened = stored(editor.document)
    expect(withoutIds(opened)).toEqual(row.bodyJson)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ type: 'table' })
    expect(blocksToMarkdown(opened)).toBe(row.bodyMd)

    const values = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, dealId))
    ).at(0)?.values
    expect(values?.liquidation_preference).toBeUndefined()
  })

  it('refuses a document with no deal in its filing, before any model call', async () => {
    await routeExtract()
    const companyId = await company()
    const { documentId } = await termSheet([companyId])
    const model = mockModel(() => ANSWER(documentId))
    const before = await usageCount()

    const failure = await Effect.runPromise(
      Effect.flip(keyTermsProgram({ documentId, userId: PROPOSER, model })),
    )
    expect(keyTermsMessage(failure)).toBe(NO_DEAL)
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await usageCount()).toBe(before)
    expect(
      await db
        .select()
        .from(suggestion)
        .where(eq(suggestion.entityId, companyId)),
    ).toHaveLength(0)
  })

  it('refuses an article', async () => {
    await routeExtract()
    const dealId = await deal()
    const { documentId } = await termSheet([dealId], 'article')
    const model = mockModel(() => ANSWER(documentId))
    const failure = await Effect.runPromise(
      Effect.flip(keyTermsProgram({ documentId, userId: PROPOSER, model })),
    )
    expect(keyTermsMessage(failure)).toMatch(/legal or diligence/)
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it('proposes nothing when the document states no term', async () => {
    await routeExtract()
    const dealId = await deal()
    const { documentId, filename } = await termSheet([dealId], 'dd')
    const failure = await Effect.runPromise(
      Effect.flip(
        keyTermsProgram({
          documentId,
          userId: PROPOSER,
          model: mockModel(() => ({
            litigation: { value: 'N/A', refs: [`doc:${documentId}#0`] },
          })),
        }),
      ),
    )
    expect(keyTermsMessage(failure)).toBe(`No key terms found in ${filename}`)
    expect(
      await db.select().from(suggestion).where(eq(suggestion.entityId, dealId)),
    ).toHaveLength(0)
  })

  it('names the lane when extract is not routed', async () => {
    await Effect.runPromise(clearAiRouteProgram('extract', 'normal'))
    const dealId = await deal()
    const { documentId } = await termSheet([dealId])
    const failure = await Effect.runPromise(
      Effect.flip(
        keyTermsProgram({
          documentId,
          userId: PROPOSER,
          model: mockModel(() => ANSWER(documentId)),
        }),
      ),
    )
    expect(keyTermsMessage(failure)).toContain('extract')
  })
})

describe('the trigger', () => {
  it('queues one job per document; a second press is refused while it runs', async () => {
    const dealId = await deal()
    const { documentId } = await termSheet([dealId])
    expect(
      await Effect.runPromise(enqueueKeyTermsProgram(documentId, PROPOSER)),
    ).toEqual({ status: 'queued' })
    expect(
      await Effect.runPromise(enqueueKeyTermsProgram(documentId, PROPOSER)),
    ).toEqual({ status: 'already-extracting' })
    expect(enqueued).toEqual([
      {
        name: QUEUES.extractKeyTerms,
        data: { documentId, userId: PROPOSER },
        options: { singletonKey: documentId },
      },
    ])
    expect(
      await Effect.runPromise(keyTermsStatusProgram([documentId])),
    ).toEqual({ [documentId]: { state: 'extracting' } })
  })

  it('refuses a document on no deal, and an article', async () => {
    const companyId = await company()
    const { documentId } = await termSheet([companyId])
    const noDeal = await Effect.runPromise(
      Effect.flip(enqueueKeyTermsProgram(documentId, PROPOSER)),
    )
    expect(keyTermsMessage(noDeal)).toBe(NO_DEAL)
    const dealId = await deal()
    const article = await termSheet([dealId], 'article')
    const refused = await Effect.runPromise(
      Effect.flip(enqueueKeyTermsProgram(article.documentId, PROPOSER)),
    )
    expect(keyTermsMessage(refused)).toMatch(/legal or diligence/)
    expect(enqueued).toEqual([])
  })

  it('reads a settled job as the button does', () => {
    const at = new Date('2026-09-25T10:00:00Z')
    expect(keyTermsStatusOf([])).toEqual({ state: 'idle' })
    expect(
      keyTermsStatusOf([{ state: 'completed', output: null, createdOn: at }]),
    ).toEqual({ state: 'done', at: at.toISOString() })
    expect(
      keyTermsStatusOf([
        { state: 'failed', output: { reason: NO_DEAL }, createdOn: at },
      ]),
    ).toEqual({ state: 'failed', message: NO_DEAL, at: at.toISOString() })
  })
})
