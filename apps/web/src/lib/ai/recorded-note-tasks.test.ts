import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { suggestion } from '@spaces/db/schema'
import { ref } from '@spaces/core/context/ref'
import { QUEUES } from '@spaces/core/queue/names'
import { meetingDetailProgram } from '#/lib/interactions/meeting-read'
import { truncateAndReseed } from '#/test/reseed'
import {
  callTag,
  deliver,
  flent,
  founderCall,
  granola,
  granolaNote,
  sentJobs,
} from '#/test/recorded-note'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { actionItemsOf, recordedNoteTasksProgram } from './recorded-note-tasks'
import { setAiRouteProgram } from './route'
import { setEntitySensitiveProgram } from './sensitivity-for'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * A recorded note's action items (D78) through an injected model: the
 * landing, the routes, the live sensitivity read and the proposal writer are
 * real; nothing reaches a network.
 */

const ITEMS = {
  items: [
    { title: 'Send the data room', due: '2026-10-30' },
    { title: 'Intro Maya to Priya' },
  ],
}

/** Answers the extract lane with `ITEMS`, counting its calls. */
function mockModel() {
  const calls: Array<string> = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) => {
      calls.push(JSON.stringify(options.prompt))
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(ITEMS) }],
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
      })
    },
  })
  return { model, calls }
}

const route = (
  sensitivity: 'normal' | 'sensitive',
  provider: 'anthropic' | 'ollama',
) =>
  Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity,
      provider,
      model: 'some-model',
    }),
  )

// The routes are workspace rows, so each case starts from none.
beforeEach(async () => {
  await truncateAndReseed()
  sentJobs.length = 0
}, 60_000)

/** A founder call with Granola's note landed; the job the port queued. */
async function landed() {
  const tag = callTag()
  const company = await flent(tag)
  const start = new Date(Date.now() - 24 * 3_600_000)
  const meeting = await founderCall(tag, start)
  const row = await granola({ typed_notes: false, transcript: false })
  await deliver(row, granolaNote(tag, start))
  const job = sentJobs.find((j) => j.queue === QUEUES.recordedNoteTasks)
  if (job === undefined) throw new Error('no tasks job queued')
  const data = job.data
  if (
    typeof data !== 'object' ||
    data === null ||
    !('noteId' in data) ||
    typeof data.noteId !== 'string' ||
    !('receiptId' in data) ||
    typeof data.receiptId !== 'string'
  )
    throw new Error('a malformed job')
  return {
    company,
    meeting,
    integrationId: row.id,
    noteId: data.noteId,
    receiptId: data.receiptId,
  }
}

const tasksOn = (entityId: string) =>
  db
    .select({
      kind: suggestion.kind,
      payload: suggestion.payload,
      refs: suggestion.refs,
      proposedByType: suggestion.proposedByType,
      proposedById: suggestion.proposedById,
    })
    .from(suggestion)
    .where(eq(suggestion.entityId, entityId))

describe("a recorded note's action items", () => {
  it('two items in the summary propose two task suggestions citing the note, once', async () => {
    await route('normal', 'anthropic')
    const f = await landed()
    const { model, calls } = mockModel()
    const out = await Effect.runPromise(
      recordedNoteTasksProgram({
        interactionId: f.meeting,
        noteId: f.noteId,
        integrationId: f.integrationId,
        receiptId: f.receiptId,
        model,
      }),
    )
    expect(out.status).toBe('proposed')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('Send the data room')
    const cites = [
      ref.note(f.noteId),
      ref.interaction(f.meeting),
      ref.event(f.receiptId),
    ]
    expect(await tasksOn(f.company)).toEqual([
      {
        kind: 'task',
        payload: {
          title: 'Send the data room',
          due: '2026-10-30',
          entity_id: f.company,
        },
        refs: cites,
        proposedByType: 'integration',
        proposedById: f.integrationId,
      },
      {
        kind: 'task',
        payload: {
          title: 'Intro Maya to Priya',
          due: null,
          entity_id: f.company,
        },
        refs: cites,
        proposedByType: 'integration',
        proposedById: f.integrationId,
      },
    ])
    // The two cards wait on the meeting window too.
    const window = await Effect.runPromise(
      meetingDetailProgram(FIXTURE_ACTOR, f.meeting),
    )
    expect(window.suggestions.map((s) => s.summary)).toEqual([
      'Send the data room',
      'Intro Maya to Priya',
    ])

    // Retried: the note's items were proposed, so nothing more.
    const again = await Effect.runPromise(
      recordedNoteTasksProgram({
        interactionId: f.meeting,
        noteId: f.noteId,
        integrationId: f.integrationId,
        receiptId: f.receiptId,
        model,
      }),
    )
    expect(again.status).toBe('skipped')
    expect(calls).toHaveLength(1)
    expect(await tasksOn(f.company)).toHaveLength(2)
  })

  it('a sensitive meeting with no local route proposes none', async () => {
    await route('normal', 'anthropic')
    const f = await landed()
    await Effect.runPromise(setEntitySensitiveProgram(f.company, true))
    const { model, calls } = mockModel()
    const input = {
      interactionId: f.meeting,
      noteId: f.noteId,
      integrationId: f.integrationId,
      receiptId: f.receiptId,
      model,
    }
    expect(
      (await Effect.runPromise(recordedNoteTasksProgram(input))).status,
    ).toBe('unrouted')
    await route('sensitive', 'anthropic')
    expect(
      (await Effect.runPromise(recordedNoteTasksProgram(input))).status,
    ).toBe('refused')
    expect(calls).toEqual([])
    expect(await tasksOn(f.company)).toEqual([])
  })

  it('a sensitive meeting extracts on a local route', async () => {
    await route('sensitive', 'ollama')
    const f = await landed()
    await Effect.runPromise(setEntitySensitiveProgram(f.company, true))
    const { model } = mockModel()
    const out = await Effect.runPromise(
      recordedNoteTasksProgram({
        interactionId: f.meeting,
        noteId: f.noteId,
        integrationId: f.integrationId,
        receiptId: f.receiptId,
        model,
      }),
    )
    expect(out.status).toBe('proposed')
    expect(await tasksOn(f.company)).toHaveLength(2)
  })
})

describe('actionItemsOf', () => {
  it('trims, dedupes, drops blanks and keeps only a real day', () => {
    expect(
      actionItemsOf({
        items: [
          { title: '  Send   the deck ', due: 'next week' },
          { title: 'send the deck' },
          { title: ' ' },
          { title: 'Book the call', due: '2026-11-02' },
        ],
      }),
    ).toEqual([
      { title: 'Send the deck', due: null },
      { title: 'Book the call', due: '2026-11-02' },
    ])
    expect(actionItemsOf({ nope: true })).toBeNull()
  })
})
