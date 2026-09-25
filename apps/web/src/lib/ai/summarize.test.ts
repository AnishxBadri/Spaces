import { randomUUID } from 'node:crypto'
import { BlockNoteEditor } from '@blocknote/core'
import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, count, eq } from 'drizzle-orm'
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
import { activity } from '@spaces/db/schema/activity'
import { user } from '@spaces/db/schema/auth'
import { readNotePayload } from '@spaces/core/ai/note'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { editorBlocks } from '#/test/note-blocks'
import { jsonValue } from '#/lib/json'
import type { Json } from '#/lib/json'
import { resolveEntity } from '#/lib/entities/resolve'
import {
  blocksToMarkdown,
  noteBodyFromMarkdown,
} from '#/lib/notes/markdown-blocks'
import { acceptProgram, rejectProgram, suggestionMessage } from './propose'
import { clearAiRouteProgram, setAiRouteProgram } from './route'
import {
  NOTHING_TO_SUMMARIZE,
  enqueueSummarizeProgram,
  summarizeMessage,
  summarizeProgram,
  summarizeStatusProgram,
} from './summarize'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-66. Summarize through an injected model (`MockLanguageModelV4`, as
 * the deck reader's tests): the route, the sensitivity read, the assembler,
 * the citation labels and the suggestion row are real; nothing reaches a
 * network. Accept and reject go through `acceptProgram` / `rejectProgram`,
 * the inbox's own doors.
 */

const PROPOSER = FIXTURE_ACTOR.id
const ACCEPTER = {
  id: 'spa66-accepter',
  name: 'Accepter',
  email: 'accepter@spaces.test',
  emailVerified: true,
}

/** A text model: answers `answer(prompt)`, and records every call. */
function mockModel(answer: (prompt: string) => string) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) =>
      Promise.resolve({
        content: [
          { type: 'text', text: answer(JSON.stringify(options.prompt)) },
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

async function routeSynthesize() {
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'synthesize',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    }),
  )
}

async function company(name = 'Acme') {
  const tag = randomUUID().slice(0, 8)
  const c = await resolveEntity({
    kind: 'company',
    name: `${name} ${tag}`,
    keys: { domain: `acme-${tag}.example` },
    source: { class: 'manual' },
  })
  return c.entityId
}

/** A diligence pack filed against the company, chunked with real pages. */
async function packOn(companyId: string) {
  const tag = randomUUID().slice(0, 8)
  const filename = `acme_dd_${tag}.pdf`
  const [docEnt] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: filename })
    .returning({ id: entity.id })
  // A fixture wanting a document already extracted — the state the
  // button appears in.
  await db.insert(document).values({
    entityId: docEnt.id,
    filename,
    kind: 'dd',
    sourceClass: 'manual',
    extractionStatus: 'done',
    extractedText: 'Acme DD pack.',
  })
  await db.insert(chunk).values(
    [
      { text: 'Acme builds liquid cooling for edge data centres.', page: 1 },
      { text: 'ARR $1.2M, growing 3x year on year.', page: 4 },
      { text: 'Top two customers are 70% of revenue.', page: 12 },
    ].map((c, idx) => ({
      entityId: docEnt.id,
      sourceKind: 'document' as const,
      idx,
      text: c.text,
      page: c.page,
    })),
  )
  await db.insert(link).values({
    fromEntityId: docEnt.id,
    toEntityId: companyId,
    relation: 'tagged_in',
    source: 'manual',
  })
  return { documentId: docEnt.id, filename }
}

/** A note filed against the record, shared or private. */
async function noteOn(
  recordId: string,
  bodyMd: string,
  visibility: 'shared' | 'private',
) {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: 'Call', createdBy: PROPOSER })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: ent.id,
    title: 'Call',
    bodyMd,
    authorId: PROPOSER,
    visibility,
  })
  await db.insert(link).values({
    fromEntityId: ent.id,
    toEntityId: recordId,
    relation: 'tagged_in',
    source: 'manual',
  })
  return ent.id
}

const SUMMARY = (documentId: string) =>
  [
    `Acme sells liquid cooling to edge operators [doc:${documentId}#0].`,
    '',
    '## Traction',
    '',
    `- **ARR** of $1.2M, up 3x [doc:${documentId}#1]`,
    `- A claim from nowhere [doc:${documentId}#99]`,
    '',
    '## Risks',
    '',
    `- Concentration: top two are 70% [doc:${documentId}#2]`,
  ].join('\n')

const counts = async () => {
  const [n] = await db.select({ value: count() }).from(note)
  const [e] = await db.select({ value: count() }).from(entity)
  const [l] = await db.select({ value: count() }).from(link)
  const [a] = await db.select({ value: count() }).from(activity)
  return { notes: n.value, entities: e.value, links: l.value, acts: a.value }
}

const usageCount = async () =>
  (await db.select({ value: count() }).from(aiUsage))[0].value

/** A document read back out of BlockNote, as the column would store it. */
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

const typeOf = (b: Json): Json | undefined =>
  b !== null && typeof b === 'object' && !Array.isArray(b) ? b.type : undefined

beforeEach(async () => {
  enqueued.length = 0
  await db.insert(user).values(ACCEPTER).onConflictDoNothing()
})

describe('summarize a document', () => {
  it('proposes one note on the record, citations written into the body as page words', async () => {
    await routeSynthesize()
    const companyId = await company()
    const { documentId, filename } = await packOn(companyId)
    const model = mockModel(() => SUMMARY(documentId))

    const s = await Effect.runPromise(
      summarizeProgram({
        recordId: companyId,
        documentId,
        userId: PROPOSER,
        model,
      }),
    )
    expect(s.kind).toBe('note')
    expect(s.entityId).toBe(companyId)
    expect(s.status).toBe('open')

    // The whole pack leads the prompt, each chunk under its own ref and page.
    expect(model.doGenerateCalls).toHaveLength(1)
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain(`[doc:${documentId}#2] ${filename} p.12`)

    const payload = readNotePayload(s.payload)
    expect(payload?.sourceId).toBe(documentId)
    expect(payload?.title).toBe(`Summary: ${filename}`)
    const escaped = filename.replace(/_/g, '\\_')
    expect(payload?.markdown).toContain(`(${escaped}, p.4)`)
    expect(payload?.markdown).toContain(`(${escaped}, p.12)`)
    // A ref the context never carried is dropped, not printed.
    expect(payload?.markdown).not.toContain('#99')
    expect(payload?.markdown).toContain('- A claim from nowhere\n')
    expect(s.refs).toEqual([
      `doc:${documentId}#0`,
      `doc:${documentId}#1`,
      `doc:${documentId}#2`,
    ])
  })

  it('accepting writes a shared note by the accepter, filed on the record and derived from the document, that opens populated', async () => {
    await routeSynthesize()
    const companyId = await company()
    const { documentId, filename } = await packOn(companyId)
    const s = await Effect.runPromise(
      summarizeProgram({
        recordId: companyId,
        documentId,
        userId: PROPOSER,
        model: mockModel(() => SUMMARY(documentId)),
      }),
    )

    const accepted = await Effect.runPromise(
      acceptProgram(s.id, { type: 'user', id: ACCEPTER.id }),
    )
    if (accepted.kind !== 'note') throw new Error('expected a note accept')
    expect(accepted.suggestion.status).toBe('accepted')
    const noteId = accepted.noteId

    const row = (
      await db.select().from(note).where(eq(note.entityId, noteId))
    ).at(0)
    if (!row) throw new Error('no note row')
    expect(row.authorId).toBe(ACCEPTER.id)
    expect(row.visibility).toBe('shared')
    expect(row.kind).toBe('note')
    expect(row.title).toBe(`Summary: ${filename}`)

    const edges = await db
      .select({ to: link.toEntityId, relation: link.relation })
      .from(link)
      .where(eq(link.fromEntityId, noteId))
    expect(edges).toEqual(
      expect.arrayContaining([
        { to: companyId, relation: 'tagged_in' },
        { to: documentId, relation: 'derived_from' },
      ]),
    )
    expect(edges).toHaveLength(2)

    // Round trip. The stored JSON is the renderer's typed blocks for the
    // payload, exactly; those blocks open in BlockNote as themselves (ids
    // aside); and the stored markdown is the markdown of what opened.
    const payload = readNotePayload(s.payload)
    if (!payload) throw new Error('no note payload')
    const rendered = noteBodyFromMarkdown(payload.markdown).bodyJson
    expect(row.bodyJson).toEqual(stored(rendered))
    const editor = BlockNoteEditor.create({
      initialContent: editorBlocks(rendered),
    })
    const opened = stored(editor.document)
    expect(withoutIds(opened)).toEqual(row.bodyJson)
    expect(opened.map(typeOf)).toEqual([
      'paragraph',
      'heading',
      'bulletListItem',
      'bulletListItem',
      'heading',
      'bulletListItem',
    ])
    expect(blocksToMarkdown(opened)).toBe(row.bodyMd)

    // The citation is the note's own text: it outlives the suggestion row.
    await db.delete(suggestion).where(eq(suggestion.id, s.id))
    const after = (
      await db
        .select({ bodyMd: note.bodyMd })
        .from(note)
        .where(eq(note.entityId, noteId))
    ).at(0)
    expect(after?.bodyMd).toContain(`(${filename.replace(/_/g, '\\_')}, p.4)`)

    const acts = await db
      .select()
      .from(activity)
      .where(eq(activity.objectEntityId, noteId))
    expect(acts).toHaveLength(1)
    expect(acts[0]).toMatchObject({
      verb: 'note.created',
      actorId: ACCEPTER.id,
      subjectEntityId: companyId,
    })
  })

  it('rejecting writes nothing — no note, no entity, no link, no activity', async () => {
    await routeSynthesize()
    const companyId = await company()
    const { documentId } = await packOn(companyId)
    const s = await Effect.runPromise(
      summarizeProgram({
        recordId: companyId,
        documentId,
        userId: PROPOSER,
        model: mockModel(() => SUMMARY(documentId)),
      }),
    )
    const before = await counts()
    const rejected = await Effect.runPromise(
      rejectProgram(s.id, { type: 'user', id: ACCEPTER.id }),
    )
    expect(rejected.status).toBe('rejected')
    expect(await counts()).toEqual(before)
  })

  it('a note is accepted whole, and a source deleted since refuses the accept', async () => {
    await routeSynthesize()
    const companyId = await company()
    const { documentId } = await packOn(companyId)
    const s = await Effect.runPromise(
      summarizeProgram({
        recordId: companyId,
        documentId,
        userId: PROPOSER,
        model: mockModel(() => SUMMARY(documentId)),
      }),
    )
    const byField = await Effect.runPromise(
      Effect.flip(
        acceptProgram(s.id, { type: 'user', id: ACCEPTER.id }, ['title']),
      ),
    )
    expect(suggestionMessage(byField)).toContain('accepted whole')

    await db
      .update(suggestion)
      .set({
        payload: {
          title: 'Summary',
          markdown: 'x',
          sourceId: randomUUID(),
        },
      })
      .where(eq(suggestion.id, s.id))
    const before = await counts()
    const gone = await Effect.runPromise(
      Effect.flip(acceptProgram(s.id, { type: 'user', id: ACCEPTER.id })),
    )
    expect(suggestionMessage(gone)).toContain('no longer exists')
    expect(await counts()).toEqual(before)
    const still = await db
      .select({ status: suggestion.status })
      .from(suggestion)
      .where(eq(suggestion.id, s.id))
    expect(still[0].status).toBe('open')
  })
})

describe('summarize a record', () => {
  it('refuses "Nothing to summarize" for a record with no notes and no documents, before any model call', async () => {
    await routeSynthesize()
    const companyId = await company('Empty')
    const model = mockModel(() => 'never')
    const usageBefore = await usageCount()

    const failure = await Effect.runPromise(
      Effect.flip(
        summarizeProgram({
          recordId: companyId,
          documentId: null,
          userId: PROPOSER,
          model,
        }),
      ),
    )
    expect(summarizeMessage(failure)).toMatch(
      new RegExp(`^${NOTHING_TO_SUMMARIZE}`),
    )
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await usageCount()).toBe(usageBefore)
    const rows = await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.entityId, companyId))
    expect(rows).toHaveLength(0)
  })

  it('summarizes its shared notes, leaves a private note out, and files the note on the record', async () => {
    await routeSynthesize()
    const companyId = await company()
    const sharedId = await noteOn(
      companyId,
      'Met the founders; strong team.',
      'shared',
    )
    await noteOn(companyId, 'PRIVATE: my own doubts about the CFO.', 'private')
    const model = mockModel(() => `Strong team [note:${sharedId}].`)

    const s = await Effect.runPromise(
      summarizeProgram({
        recordId: companyId,
        documentId: null,
        userId: PROPOSER,
        model,
      }),
    )
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain('strong team')
    expect(prompt).not.toContain('PRIVATE')
    const payload = readNotePayload(s.payload)
    expect(payload?.sourceId).toBe(companyId)
    expect(payload?.markdown).toBe('Strong team (Call).')

    const accepted = await Effect.runPromise(
      acceptProgram(s.id, { type: 'user', id: PROPOSER }),
    )
    if (accepted.kind !== 'note') throw new Error('expected a note accept')
    const edges = await db
      .select({ relation: link.relation })
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, accepted.noteId),
          eq(link.toEntityId, companyId),
        ),
      )
    expect(edges.map((e) => e.relation).sort()).toEqual([
      'derived_from',
      'tagged_in',
    ])
  })

  it('refuses a record the lane is not routed for, naming the lane', async () => {
    await Effect.runPromise(clearAiRouteProgram('synthesize', 'normal'))
    const companyId = await company()
    await noteOn(companyId, 'Something to say.', 'shared')
    const failure = await Effect.runPromise(
      Effect.flip(
        summarizeProgram({
          recordId: companyId,
          documentId: null,
          userId: PROPOSER,
          model: mockModel(() => 'x'),
        }),
      ),
    )
    expect(summarizeMessage(failure)).toContain('synthesize')
  })
})

describe('the trigger', () => {
  it('queues one job per record and source; a second press is refused while it runs', async () => {
    const companyId = await company()
    const { documentId } = await packOn(companyId)
    const input = { recordId: companyId, documentId, userId: PROPOSER }

    expect(await Effect.runPromise(enqueueSummarizeProgram(input))).toEqual({
      status: 'queued',
    })
    expect(await Effect.runPromise(enqueueSummarizeProgram(input))).toEqual({
      status: 'already-summarizing',
    })
    expect(enqueued).toEqual([
      {
        name: QUEUES.summarize,
        data: input,
        options: { singletonKey: `${companyId}:${documentId}` },
      },
    ])
    // The record's own summary is a different key, so it is not refused.
    expect(
      await Effect.runPromise(
        enqueueSummarizeProgram({ ...input, documentId: null }),
      ),
    ).toEqual({ status: 'queued' })

    const status = await Effect.runPromise(
      summarizeStatusProgram(companyId, [documentId, companyId]),
    )
    expect(status[documentId]).toEqual({ state: 'summarizing' })
    expect(status[companyId]).toEqual({ state: 'summarizing' })
  })

  it('refuses a document whose text is not extracted', async () => {
    const companyId = await company()
    const { documentId } = await packOn(companyId)
    await db
      .update(document)
      .set({ extractionStatus: 'pending' })
      .where(eq(document.entityId, documentId))
    const failure = await Effect.runPromise(
      Effect.flip(
        enqueueSummarizeProgram({
          recordId: companyId,
          documentId,
          userId: PROPOSER,
        }),
      ),
    )
    expect(summarizeMessage(failure)).toContain('extracted')
    expect(enqueued).toHaveLength(0)
  })
})
