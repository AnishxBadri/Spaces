import { Effect, Exit, Layer } from 'effect'
import { and, count, eq, like } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  enrichmentRecord,
  entity,
  integration,
  interaction,
  interactionDocument,
  interactionNote,
  note,
  suggestion,
} from '@spaces/db/schema'
import { Content } from '@spaces/sdk'
import type { RecordedNote, RecordedNoteGone } from '@spaces/sdk'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { ref } from '../../context/ref'
import { Enqueue } from '../../queue/enqueue'
import { encryptBundle } from '../connections/bundle'
import { resolveEntity } from '../entities/resolve'
import { ContentLive } from '../ports/content'
import { NoEmailLane } from './email-lane'
import { MeetingLane } from './meeting-lane'
import { removeConnectionRecordings } from './recorded-note'
import { insertBodyNote, writeIntegrationInteraction } from './write'

/**
 * The recorder contract's host half (D78) through `Content.logRecordedNote`:
 * a recorded note attaches to its calendar meeting by event id, else by
 * start time and attendees inside 30 minutes, else births a call; delivered
 * twice it is one row and one receipt; gone, it takes with it what it became.
 */

const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** A person per address, as the arrival lane's participants module would. */
const LaneTest = Layer.succeed(
  MeetingLane,
  MeetingLane.of({
    log: () => Effect.die('no meetings here'),
    participants: (_ctx, people) =>
      Effect.promise(async () => {
        const ids: Array<string> = []
        for (const p of people)
          ids.push(
            (
              await resolveEntity({
                kind: 'person',
                keys: { email: p.email },
                source: { class: 'manual' },
              })
            ).entityId,
          )
        return ids
      }),
  }),
)

type Bound = { id: string; capabilityId: string; connectionId: string | null }

/** An installed recorder, and a member's key connection when `keyed`. */
const recorder = async (capabilityId: string, keyed: boolean) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true })
      .returning({ id: integration.id, capabilityId: integration.capabilityId })
  ).at(0)
  if (!row) throw new Error('no integration')
  if (!keyed) return { ...row, connectionId: null }
  const conn = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: capabilityId,
        product: 'notes',
        externalEmail: `${crypto.randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          { type: 'api_key', key: 'grn_test' },
          { userId: FIXTURE_ACTOR.id, provider: capabilityId },
        ),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!conn) throw new Error('no connection')
  return { ...row, connectionId: conn.id }
}

const log = (row: Bound, claim: RecordedNote | RecordedNoteGone) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* Content).logRecordedNote(claim)
    }).pipe(
      Effect.provide(
        ContentLive(row).pipe(
          Layer.provide(Layer.mergeAll(EnqueueTest, LaneTest, NoEmailLane)),
        ),
      ),
    ),
  )

const valueOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>): TValue => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`failed: ${String(exit.cause)}`)
}

/** Each case on its own day, so no case's meetings fall in another's window. */
let day = 0
const nextDay = () => {
  day += 1
  return new Date(Date.UTC(2026, 9, 1 + day, 10)).toISOString()
}
const later = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString()

/** A synced calendar meeting at `at`, with these attendees. */
const meeting = async (
  integrationId: string,
  uid: string,
  at: string,
  emails: ReadonlyArray<string>,
  calendarEventId?: string,
) => {
  const written = await db.transaction((tx) =>
    writeIntegrationInteraction(tx, {
      integrationId,
      kind: 'meeting',
      messageId: uid,
      threadId: null,
      subject: 'Flent — first call',
      occurredAt: new Date(at),
      meta: {
        kind: 'meeting',
        ends_at: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
        status: 'scheduled',
        conference_url: null,
        organizer: 'anish@fund.example',
        recurring_instance_id: null,
        rsvp: Object.fromEntries(emails.map((e) => [e, 'accepted'])),
        ...(calendarEventId === undefined
          ? {}
          : { calendar_event_id: calendarEventId }),
      },
      body: null,
      edges: [],
    }),
  )
  if (written.kind !== 'written') throw new Error('meeting not written')
  return written.interactionId
}

const calendar = async () => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'google-calendar', version: '0.1.0' })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no calendar row')
  return row.id
}

const note1 = (
  startedAt: string,
  extra: Partial<RecordedNote> = {},
): RecordedNote => ({
  _tag: 'recorded-note',
  providerNoteId: 'not_flent_first',
  title: 'Flent — first call',
  startedAt,
  attendees: [
    { email: 'anish@fund.example' },
    { email: 'Maya@Flent.example', name: 'Maya Rao' },
  ],
  summary: '## Flent\n- Raising a seed',
  raw: { id: 'not_flent_first', summary_markdown: '## Flent' },
  ...extra,
})

/** The receipts this integration stored. */
const receipts = async (integrationId: string) =>
  (
    await db
      .select({ n: count() })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, integrationId))
  ).at(0)?.n ?? 0

/** The calls this integration's notes were born as. */
const calls = (integrationId: string) =>
  db
    .select({ id: interaction.id, messageId: interaction.messageId })
    .from(interaction)
    .where(
      and(
        eq(interaction.kind, 'call'),
        like(interaction.messageId, `rec:${integrationId}:%`),
      ),
    )

/** Entities of `kind` this integration wrote. */
const written = async (integrationId: string, kind: 'note' | 'document') =>
  (
    await db
      .select({ n: count() })
      .from(entity)
      .where(and(eq(entity.sourceRef, integrationId), eq(entity.kind, kind)))
  ).at(0)?.n ?? 0

const tasksOf = (integrationId: string) =>
  db
    .select({ id: suggestion.id })
    .from(suggestion)
    .where(eq(suggestion.proposedById, integrationId))

/** What arrival-7 would write for a delivered note, by hand. */
const landed = async (row: Bound, interactionId: string) => {
  const receipt = (
    await db
      .select({ id: enrichmentRecord.id })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, row.id))
  ).at(0)
  if (!receipt) throw new Error('no receipt')
  const body = (title: string, visibility: 'shared' | 'private') =>
    db.transaction((tx) =>
      insertBodyNote(tx, row.id, {
        title,
        text: title,
        authorId: FIXTURE_ACTOR.id,
        visibility,
      }),
    )
  const writeUp = await body('Granola notes', 'shared')
  await db
    .update(interaction)
    .set({ noteId: writeUp })
    .where(eq(interaction.id, interactionId))
  const typed = await body('Typed notes', 'private')
  await db
    .insert(interactionNote)
    .values({ interactionId, noteId: typed, role: 'typed_notes' })
  const docEntity = (
    await db
      .insert(entity)
      .values({
        kind: 'document',
        canonicalName: 'Transcript',
        createdBy: FIXTURE_ACTOR.id,
        sourceClass: 'integration',
        sourceRef: row.id,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!docEntity) throw new Error('no document entity')
  await db.insert(document).values({
    entityId: docEntity.id,
    filename: 'Transcript',
    sourceClass: 'integration',
    sourceRef: row.id,
    visibility: 'private',
    authorId: FIXTURE_ACTOR.id,
    connectionId: row.connectionId,
  })
  await db.insert(interactionDocument).values({
    interactionId,
    documentId: docEntity.id,
    role: 'transcript',
  })
  const person = await resolveEntity({
    kind: 'person',
    keys: { email: 'maya@flent.example' },
    source: { class: 'manual' },
  })
  const task = (refs: Array<string>) =>
    db
      .insert(suggestion)
      .values({
        entityId: person.entityId,
        kind: 'task',
        payload: { title: 'Send the data room' },
        refs,
        proposedByType: 'integration',
        proposedById: row.id,
      })
      .returning({ id: suggestion.id })
  const cited = (await task([ref.event(receipt.id)])).at(0)?.id
  const other = (await task([ref.interaction(interactionId)])).at(0)?.id
  return {
    receipt: receipt.id,
    writeUp,
    typed,
    doc: docEntity.id,
    cited,
    other,
  }
}

const gone = (row: Bound) =>
  log(row, { _tag: 'recorded-note-gone', providerNoteId: 'not_flent_first' })

const exists = async (table: typeof note | typeof document, id: string) =>
  (
    await db
      .select({ id: table.entityId })
      .from(table)
      .where(eq(table.entityId, id))
  ).length > 0

const metaOf = async (interactionId: string) =>
  (
    await db
      .select({ noteId: interaction.noteId, meta: interaction.meta })
      .from(interaction)
      .where(eq(interaction.id, interactionId))
  ).at(0)

const eventsOf = async (interactionId: string) => {
  const meta = (await metaOf(interactionId))?.meta
  return meta?.kind === 'meeting'
    ? (meta.recorder_events ?? []).map((e) => e.provider_event_id)
    : null
}

describe('a recorded note finds its meeting', () => {
  it('by calendar_event_id', async () => {
    const start = nextDay()
    const cal = await calendar()
    const held = await meeting(
      cal,
      `flent-${start}@google.com`,
      later(start, -60),
      ['maya@flent.example'],
      `gcal-${start}`,
    )
    const row = await recorder('granola', true)
    const out = valueOf(
      await log(row, note1(start, { calendarEventId: `gcal-${start}` })),
    )
    expect(out).toEqual({ outcome: 'attached', interactionId: held })
    expect(await calls(row.id)).toEqual([])
  })

  it('without one, by start time and attendee emails inside 30 minutes', async () => {
    const start = nextDay()
    const cal = await calendar()
    const held = await meeting(cal, `near-${start}`, later(start, 20), [
      'anish@fund.example',
      'maya@flent.example',
    ])
    // Outside the window: never the one.
    await meeting(cal, `far-${start}`, later(start, 45), [
      'anish@fund.example',
      'maya@flent.example',
    ])
    const row = await recorder('granola', true)
    const out = valueOf(await log(row, note1(start)))
    expect(out).toEqual({ outcome: 'attached', interactionId: held })
  })

  it('with no match, births a call keyed per connection', async () => {
    const row = await recorder('granola', true)
    const out = valueOf(await log(row, note1(nextDay())))
    expect(out.outcome).toBe('born')
    expect(await calls(row.id)).toEqual([
      {
        id: out.interactionId,
        messageId: `rec:${row.id}:${row.connectionId}:not_flent_first`,
      },
    ])
  })
})

describe('the same note delivered twice', () => {
  it('is one interaction and one receipt', async () => {
    const start = nextDay()
    const row = await recorder('granola', true)
    const first = valueOf(await log(row, note1(start)))
    const again = valueOf(await log(row, note1(start)))
    expect(again).toEqual({
      outcome: 'duplicate',
      interactionId: first.interactionId,
    })
    expect(await calls(row.id)).toHaveLength(1)
    expect(await receipts(row.id)).toBe(1)
  })

  it("from two members is two copies on one meeting, each the member's", async () => {
    const start = nextDay()
    const cal = await calendar()
    const held = await meeting(
      cal,
      `two-${start}`,
      start,
      ['maya@flent.example'],
      `gcal-${start}`,
    )
    const a = await recorder('granola', true)
    const other = await recorder('granola', true)
    const b = { ...a, connectionId: other.connectionId }
    const claim = note1(start, { calendarEventId: `gcal-${start}` })
    valueOf(await log(a, claim))
    valueOf(await log(b, claim))
    expect(await eventsOf(held)).toEqual([
      `rec:${a.id}:${a.connectionId}:not_flent_first`,
      `rec:${a.id}:${b.connectionId}:not_flent_first`,
    ])
  })
})

describe('what a note becomes today', () => {
  it('is the row and its receipt only: the landing rules are arrival-7', async () => {
    const row = await recorder('granola', true)
    valueOf(
      await log(
        row,
        note1(nextDay(), {
          typedNotes: 'Strong founder.',
          transcript: 'Maya: hello',
        }),
      ),
    )
    expect(await written(row.id, 'note')).toBe(0)
    expect(await written(row.id, 'document')).toBe(0)
    expect(await tasksOf(row.id)).toEqual([])
    expect(await receipts(row.id)).toBe(1)
  })
})

describe('a note gone from every ticked folder, or deleted', () => {
  it('takes its write-up, typed notes, private transcript, open tasks and receipt; the meeting stays', async () => {
    const start = nextDay()
    const cal = await calendar()
    const held = await meeting(
      cal,
      `gone-${start}`,
      start,
      ['maya@flent.example'],
      `gcal-${start}`,
    )
    const row = await recorder('granola', true)
    valueOf(await log(row, note1(start, { calendarEventId: `gcal-${start}` })))
    const made = await landed(row, held)

    const out = valueOf(await gone(row))
    expect(out).toEqual({ outcome: 'removed', interactionId: held })

    const kept = await metaOf(held)
    expect(kept?.noteId).toBeNull()
    expect(kept?.meta).not.toHaveProperty('recorder_events')
    expect(await exists(note, made.writeUp)).toBe(false)
    expect(await exists(note, made.typed)).toBe(false)
    expect(await exists(document, made.doc)).toBe(false)
    expect(await tasksOf(row.id)).toEqual([{ id: made.other }])
    expect(await receipts(row.id)).toBe(0)
  })

  it('returned with deletedAt does the same, and a born call goes whole', async () => {
    const start = nextDay()
    const row = await recorder('granola', true)
    const born = valueOf(await log(row, note1(start)))
    if (born.outcome !== 'born') throw new Error(`not born: ${born.outcome}`)
    await landed(row, born.interactionId)
    const out = valueOf(
      await log(row, note1(start, { deletedAt: later(start, 600) })),
    )
    expect(out).toEqual({
      outcome: 'removed',
      interactionId: born.interactionId,
    })
    expect(await calls(row.id)).toEqual([])
    expect(await written(row.id, 'note')).toBe(0)
    expect(await written(row.id, 'document')).toBe(0)
  })

  it('that Spaces never held is a no-op', async () => {
    const row = await recorder('granola', true)
    expect(valueOf(await gone(row))).toEqual({
      outcome: 'removed',
      interactionId: null,
    })
  })
})

describe('Disconnect', () => {
  it("removes every copy the connection's runs wrote, and leaves another member's", async () => {
    const start = nextDay()
    const cal = await calendar()
    const held = await meeting(
      cal,
      `disc-${start}`,
      start,
      ['maya@flent.example'],
      `gcal-${start}`,
    )
    const a = await recorder('granola', true)
    const other = await recorder('granola', true)
    const b = { ...a, connectionId: other.connectionId }
    const claim = note1(start, { calendarEventId: `gcal-${start}` })
    valueOf(await log(a, claim))
    valueOf(
      await log(a, note1(later(start, 600), { providerNoteId: 'not_other' })),
    )
    valueOf(await log(b, claim))
    if (a.connectionId === null) throw new Error('keyed')
    expect(await removeConnectionRecordings(a.connectionId)).toBe(2)
    expect(await eventsOf(held)).toEqual([
      `rec:${a.id}:${b.connectionId}:not_flent_first`,
    ])
    expect(await calls(a.id)).toEqual([])
  })
})
