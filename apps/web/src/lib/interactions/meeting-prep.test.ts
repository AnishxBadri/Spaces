import { Effect } from 'effect'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { and, count, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  company,
  entity,
  entitySpace,
  interaction,
  interactionEntity,
  link,
  note,
  space,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { setAiRouteProgram } from '#/lib/ai/route'
import type { PrepEvent } from '#/lib/meetings/day'
import { prepEvents, prepStream, savePrepNoteProgram } from './meeting-prep'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Prep (D68): the assembler over the meeting's linked records, streamed
 * through the synthesize lane on demand and never stored; "Save as note"
 * files the brief on the same records with the reader as author; and the
 * sensitivity gate per call — a record under a sensitive space routes local
 * or refuses, and the stream says which.
 */

const run = <TValue, TError>(e: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(e)

function streamingModel(chunks: ReadonlyArray<string>) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start' as const, id: 't' },
          ...chunks.map((delta) => ({
            type: 'text-delta' as const,
            id: 't',
            delta,
          })),
          { type: 'text-end' as const, id: 't' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: {
                total: 30,
                noCache: 30,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 7, text: 7, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  })
}

async function aCompany(name: string): Promise<string> {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function aSharedNoteOn(recordId: string, body: string): Promise<string> {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: 'Call notes' })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: ent.id,
    authorId: FIXTURE_ACTOR.id,
    title: 'Call notes',
    bodyMd: body,
  })
  await db.insert(link).values({
    fromEntityId: ent.id,
    toEntityId: recordId,
    relation: 'tagged_in',
    source: 'manual',
    createdBy: FIXTURE_ACTOR.id,
  })
  return ent.id
}

async function aMeeting(subject: string, records: Array<string>) {
  const [row] = await db
    .insert(interaction)
    .values({
      kind: 'meeting',
      subject,
      occurredAt: new Date('2026-10-14T09:30:00.000Z'),
      meta: {
        kind: 'meeting',
        ends_at: '2026-10-14T10:00:00.000Z',
        status: 'scheduled',
        conference_url: null,
        organizer: null,
        recurring_instance_id: null,
        rsvp: {},
      },
    })
    .returning({ id: interaction.id })
  for (const entityId of records)
    await db
      .insert(interactionEntity)
      .values({ interactionId: row.id, entityId })
  return row.id
}

async function collect(
  events: AsyncIterable<PrepEvent>,
): Promise<Array<PrepEvent>> {
  const out: Array<PrepEvent> = []
  for await (const e of events) out.push(e)
  return out
}

const noteCount = async () =>
  (await db.select({ value: count() }).from(note)).at(0)?.value ?? 0

describe('Prep', () => {
  it('streams the brief from the linked records, stores nothing, and saves it as a note on the same records', async () => {
    await run(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const flent = await aCompany('Flent')
    const other = await aCompany('Northgate')
    const callNote = await aSharedNoteOn(flent, 'Raising a Series A in Q4.')
    const id = await aMeeting('Flent intro', [flent, other])
    const notesBefore = await noteCount()

    const model = streamingModel([
      'Flent is raising ',
      `a Series A [note:${callNote}].`,
    ])
    const events = await collect(
      prepEvents({ userId: FIXTURE_ACTOR.id, interactionId: id, model }),
    )

    expect(events.at(0)).toEqual({
      type: 'route',
      sensitive: false,
      line: 'Anthropic · claude-opus-5',
    })
    expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual([
      'Flent is raising ',
      `a Series A [note:${callNote}].`,
    ])
    // The prompt carried the linked record's note.
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      'Raising a Series A in Q4.',
    )
    // The finished brief cites in words, not refs.
    expect(events.at(-1)).toEqual({
      type: 'done',
      markdown: 'Flent is raising a Series A (Call notes).',
    })
    // Never stored: no note, one usage row for the call.
    expect(await noteCount()).toBe(notesBefore)
    const usage = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.lane, 'synthesize'))
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ tokensIn: 30, tokensOut: 7 })

    const { noteId } = await run(
      savePrepNoteProgram(FIXTURE_ACTOR.id, id, '## Flent\n- Raising an A'),
    )
    const saved = (
      await db.select().from(note).where(eq(note.entityId, noteId))
    ).at(0)
    expect(saved).toMatchObject({
      authorId: FIXTURE_ACTOR.id,
      title: 'Prep: Flent intro',
      visibility: 'shared',
    })
    expect(saved?.bodyMd).toContain('Raising an A')
    const filed = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(and(eq(link.fromEntityId, noteId), eq(link.relation, 'tagged_in')))
    expect(filed.map((f) => f.to).sort()).toEqual([flent, other].sort())
  })

  it('records the call’s usage when the reader cancels mid-way or before any text', async () => {
    await run(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const flent = await aCompany('Cancelled Co')
    const id = await aMeeting('Cut short', [flent])
    const usageRows = async () =>
      (await db.select({ value: count() }).from(aiUsage)).at(0)?.value ?? 0

    // Mid-way: the route and one delta read, then the reader cancels.
    const before = await usageRows()
    const reader = prepStream({
      userId: FIXTURE_ACTOR.id,
      interactionId: id,
      model: streamingModel(['first ', 'second ', 'third']),
    }).getReader()
    expect((await reader.read()).value).toMatchObject({ type: 'route' })
    expect((await reader.read()).value).toEqual({
      type: 'text',
      text: 'first ',
    })
    await reader.cancel()
    expect(await usageRows()).toBe(before + 1)

    // Before any text: returned at the route line.
    const events = prepEvents({
      userId: FIXTURE_ACTOR.id,
      interactionId: id,
      model: streamingModel(['never read']),
    })
    expect((await events.next()).value).toMatchObject({ type: 'route' })
    await events.return(undefined)
    expect(await usageRows()).toBe(before + 2)
    const last = await db.select().from(aiUsage)
    expect(last.every((u) => (u.tokensIn ?? 0) > 0)).toBe(true)
  })

  it('refuses before any model is called when there is nothing linked', async () => {
    const id = await aMeeting('Nobody', [])
    const model = streamingModel(['never'])
    const events = await collect(
      prepEvents({ userId: FIXTURE_ACTOR.id, interactionId: id, model }),
    )
    expect(events).toEqual([
      {
        type: 'failed',
        message: 'Nothing to prep: no records are linked to this meeting',
      },
    ])
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('refuses a record under a sensitive space on a cloud route, and runs it local, saying which', async () => {
    const [spaceEnt] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: 'Fund II', sensitive: true })
      .returning({ id: entity.id })
    await db
      .insert(space)
      .values({ entityId: spaceEnt.id, slug: 'fund_ii', path: 'fund_ii' })
    const secret = await aCompany('Quiet Co')
    await db.insert(entitySpace).values({
      entityId: secret,
      spaceId: spaceEnt.id,
      source: 'manual',
      createdBy: FIXTURE_ACTOR.id,
    })
    const id = await aMeeting('Quiet Co board', [secret])

    await run(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'sensitive',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const cloud = streamingModel(['never'])
    const refused = await collect(
      prepEvents({ userId: FIXTURE_ACTOR.id, interactionId: id, model: cloud }),
    )
    expect(refused).toEqual([
      {
        type: 'refused',
        line: 'Refused · Sensitive material is not sent to Anthropic (sensitivity inherited from Fund II); route the synthesize lane to a local model',
      },
    ])
    expect(cloud.doStreamCalls).toHaveLength(0)

    await run(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'sensitive',
        provider: 'ollama',
        model: 'llama3.2',
      }),
    )
    const local = streamingModel(['A quiet brief.'])
    const ran = await collect(
      prepEvents({ userId: FIXTURE_ACTOR.id, interactionId: id, model: local }),
    )
    expect(ran.at(0)).toEqual({
      type: 'route',
      sensitive: true,
      line: 'Sensitive (inherited from Fund II) · answered locally by Ollama · llama3.2',
    })
    expect(ran.at(-1)).toEqual({ type: 'done', markdown: 'A quiet brief.' })
  })
})
