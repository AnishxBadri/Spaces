import { Effect, Exit, Layer } from 'effect'
import { and, count, eq, like } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
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
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { ref } from '../../context/ref'
import { blocksToMarkdown } from '../../notes/markdown-blocks'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import { storage } from '../storage'
import { encryptBundle } from '../connections/bundle'
import { resolveEntity } from '../entities/resolve'
import { ContentLive } from '../ports/content'
import { NoEmailLane } from './email-lane'
import { MeetingLane } from './meeting-lane'
import { removeConnectionRecordings } from './recorded-note'
import { writeIntegrationInteraction } from './write'

/**
 * The recorder contract's host half through `Content.logRecordedNote`:
 * a recorded note attaches to its calendar meeting by event id, else by
 * start time and attendees inside 30 minutes, else births a call; delivered
 * twice it is one row and one receipt; gone, it takes with it what it became.
 */

/** Every job the port sent, in order. */
const sent: Array<{ queue: string; data: unknown; key: string | undefined }> =
  []

const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data, options) =>
      Effect.sync(() => {
        sent.push({ queue, data, key: options?.singletonKey })
        return null
      }),
  }),
)

/** The blobs a case stored, deleted after it. */
const shas = new Set<string>()

afterEach(async () => {
  sent.length = 0
  for (const sha of shas) await storage().delete(sha)
  shas.clear()
})

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

/**
 * What a delivered note became, with the extras removal must also take:
 * the real write-up and typed notes, and by hand a private transcript and
 * two open tasks — one citing the receipt, one only the meeting.
 */
const landed = async (row: Bound, interactionId: string) => {
  const receipt = (
    await db
      .select({ id: enrichmentRecord.id })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, row.id))
  ).at(0)
  if (!receipt) throw new Error('no receipt')
  const writeUp = (await metaOf(interactionId))?.noteId
  const typed = (
    await db
      .select({ id: interactionNote.noteId })
      .from(interactionNote)
      .where(
        and(
          eq(interactionNote.interactionId, interactionId),
          eq(interactionNote.role, 'typed_notes'),
        ),
      )
  ).at(0)?.id
  if (!writeUp || !typed) throw new Error('the landing wrote no notes')
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

/** A member's opt-ins on their recorder connection. */
const optIn = async (
  row: Bound,
  choices: { typed_notes?: boolean; transcript?: boolean },
) => {
  if (row.connectionId === null) throw new Error('keyed')
  await db
    .update(accountConnection)
    .set({ settings: { folder_ids: ['fld_deals'], ...choices } })
    .where(eq(accountConnection.id, row.connectionId))
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

const SUMMARY = [
  '## Flent',
  '- Raising a **seed** of $2M',
  '',
  '### Action items',
  '- Send the data room',
  '- Intro to Priya',
].join('\n')

/** A shared note this integration filed: its row and body. */
const noteRow = async (id: string) =>
  (
    await db
      .select({
        title: note.title,
        authorId: note.authorId,
        visibility: note.visibility,
        bodyJson: note.bodyJson,
        bodyMd: note.bodyMd,
      })
      .from(note)
      .where(eq(note.entityId, id))
  ).at(0)

const carriedOf = (interactionId: string | null) => {
  if (interactionId === null) throw new Error('no interaction')
  return db
    .select({ noteId: interactionNote.noteId, role: interactionNote.role })
    .from(interactionNote)
    .where(eq(interactionNote.interactionId, interactionId))
}

/** A second workspace member. */
const member = async (name: string) => {
  const id = `member-${crypto.randomUUID()}`
  await db
    .insert(user)
    .values({ id, name, email: `${id}@fund.example`, emailVerified: true })
  return id
}

const calendarMeeting = async (start: string) => {
  const cal = await calendar()
  return meeting(
    cal,
    `land-${start}`,
    start,
    ['maya@flent.example'],
    `gcal-${start}`,
  )
}

describe('what a recorded note becomes (D78)', () => {
  it('fills an empty write-up: one shared note by the member, rendered from the summary, its action items queued', async () => {
    const start = nextDay()
    const held = await calendarMeeting(start)
    const row = await recorder('granola', true)
    valueOf(
      await log(
        row,
        note1(start, {
          calendarEventId: `gcal-${start}`,
          summary: SUMMARY,
          webUrl: 'https://notes.granola.ai/d/not_flent_first',
        }),
      ),
    )
    const noteId = (await metaOf(held))?.noteId
    if (!noteId) throw new Error('no write-up')
    const body = await noteRow(noteId)
    expect(body).toMatchObject({
      title: 'Flent — first call',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
    })
    expect(body?.bodyJson?.length).toBeGreaterThan(0)
    expect(body?.bodyMd).toBe(blocksToMarkdown(body?.bodyJson ?? []))
    expect(body?.bodyMd).toContain('Send the data room')
    expect(await carriedOf(held)).toEqual([])
    expect(await tasksOf(row.id)).toEqual([])
    const receipt = (
      await db
        .select({ id: enrichmentRecord.id })
        .from(enrichmentRecord)
        .where(eq(enrichmentRecord.integrationId, row.id))
    ).at(0)?.id
    expect(sent).toEqual([
      {
        queue: QUEUES.recordedNoteTasks,
        data: {
          interactionId: held,
          noteId,
          integrationId: row.id,
          receiptId: receipt,
        },
        key: noteId,
      },
    ])
    // Open in Granola: kept on the member's recorder event.
    const meta = (await metaOf(held))?.meta
    expect(meta?.kind === 'meeting' ? meta.recorder_events : null).toEqual([
      {
        provider_event_id: `rec:${row.id}:${row.connectionId}:not_flent_first`,
        receipt_id: receipt,
        web_url: 'https://notes.granola.ai/d/not_flent_first',
      },
    ])

    // Delivered again: nothing more, and no second job.
    sent.length = 0
    valueOf(await log(row, note1(start, { calendarEventId: `gcal-${start}` })))
    expect(await written(row.id, 'note')).toBe(1)
    expect(sent).toEqual([])
  })

  it('after a hand-written write-up, lands as a second shared note and leaves the write-up as it was', async () => {
    const start = nextDay()
    const held = await calendarMeeting(start)
    const mine = (
      await db
        .insert(entity)
        .values({
          kind: 'note',
          canonicalName: 'My notes',
          createdBy: FIXTURE_ACTOR.id,
          sourceClass: 'manual',
        })
        .returning({ id: entity.id })
    ).at(0)
    if (!mine) throw new Error('no note')
    await db.insert(note).values({
      entityId: mine.id,
      authorId: FIXTURE_ACTOR.id,
      title: 'My notes',
      bodyMd: 'Typed by hand.',
    })
    await db
      .update(interaction)
      .set({ noteId: mine.id })
      .where(eq(interaction.id, held))

    const row = await recorder('granola', true)
    valueOf(
      await log(
        row,
        note1(start, { calendarEventId: `gcal-${start}`, summary: SUMMARY }),
      ),
    )
    expect((await metaOf(held))?.noteId).toBe(mine.id)
    expect(await noteRow(mine.id)).toMatchObject({
      title: 'My notes',
      bodyMd: 'Typed by hand.',
    })
    const carried = await carriedOf(held)
    expect(carried).toEqual([
      { noteId: expect.any(String), role: 'recorder_note' },
    ])
    expect(await noteRow(carried[0].noteId)).toMatchObject({
      title: `granola notes · ${FIXTURE_ACTOR.name}`,
      visibility: 'shared',
    })
    expect(await tasksOf(row.id)).toEqual([])
    expect(
      await db
        .select({ id: suggestion.id })
        .from(suggestion)
        .where(eq(suggestion.kind, 'note')),
    ).toEqual([])
  })

  it("from a second member, lands beside the first member's write-up", async () => {
    const start = nextDay()
    const held = await calendarMeeting(start)
    const a = await recorder('granola', true)
    const priya = await member('Priya')
    const conn = (
      await db
        .insert(accountConnection)
        .values({
          userId: priya,
          provider: 'granola',
          product: 'notes',
          externalEmail: `${priya}@granola.example`,
          tokensEnc: encryptBundle(
            { type: 'api_key', key: 'grn_priya' },
            { userId: priya, provider: 'granola' },
          ),
        })
        .returning({ id: accountConnection.id })
    ).at(0)
    if (!conn) throw new Error('no connection')
    const b = { ...a, connectionId: conn.id }
    await db
      .update(integration)
      .set({ manifest: { name: 'Granola' } })
      .where(eq(integration.id, a.id))
    const claim = note1(start, {
      calendarEventId: `gcal-${start}`,
      summary: SUMMARY,
    })
    valueOf(await log(a, claim))
    const writeUp = (await metaOf(held))?.noteId
    valueOf(await log(b, claim))
    expect((await metaOf(held))?.noteId).toBe(writeUp)
    const carried = await carriedOf(held)
    expect(carried.map((c) => c.role)).toEqual(['recorder_note'])
    expect(await noteRow(carried[0].noteId)).toMatchObject({
      title: 'Granola notes · Priya',
      authorId: priya,
      visibility: 'shared',
    })
    expect(await tasksOf(a.id)).toEqual([])
  })

  it('with both opt-ins off, stores no typed notes and no transcript', async () => {
    const row = await recorder('granola', true)
    const out = valueOf(
      await log(
        row,
        note1(nextDay(), {
          typedNotes: 'Strong founder.',
          transcript: 'Maya: hello',
        }),
      ),
    )
    expect(await written(row.id, 'note')).toBe(1)
    expect(await written(row.id, 'document')).toBe(0)
    expect(await carriedOf(out.interactionId)).toEqual([])
  })

  it('with both on, keeps the typed notes as a private note and the transcript as a private document', async () => {
    const start = nextDay()
    const held = await calendarMeeting(start)
    const row = await recorder('granola', true)
    await optIn(row, { typed_notes: true, transcript: true })
    valueOf(
      await log(
        row,
        note1(start, {
          calendarEventId: `gcal-${start}`,
          typedNotes: 'Strong founder.',
          transcript: 'Maya: we close in March.',
        }),
      ),
    )
    const carried = await carriedOf(held)
    expect(carried.map((c) => c.role)).toEqual(['typed_notes'])
    expect(await noteRow(carried[0].noteId)).toMatchObject({
      authorId: FIXTURE_ACTOR.id,
      visibility: 'private',
      bodyMd: 'Strong founder.\n',
    })
    const docs = await db
      .select({
        id: document.entityId,
        visibility: document.visibility,
        authorId: document.authorId,
        mime: document.mime,
        sha: document.blobSha,
        role: interactionDocument.role,
      })
      .from(interactionDocument)
      .innerJoin(
        document,
        eq(document.entityId, interactionDocument.documentId),
      )
      .where(eq(interactionDocument.interactionId, held))
    expect(docs).toEqual([
      {
        id: expect.any(String),
        visibility: 'private',
        authorId: FIXTURE_ACTOR.id,
        mime: 'text/plain',
        sha: expect.any(String),
        role: 'transcript',
      },
    ])
    const sha = docs[0].sha
    if (sha === null) throw new Error('no blob')
    shas.add(sha)
    expect(await storage().exists(sha)).toBe(true)
    // The extraction is queued like any document's.
    expect(sent.map((j) => j.queue)).toContain(QUEUES.extractDocument)

    // Again: one of each.
    valueOf(
      await log(
        row,
        note1(start, {
          calendarEventId: `gcal-${start}`,
          typedNotes: 'Strong founder.',
          transcript: 'Maya: we close in March.',
        }),
      ),
    )
    expect(await carriedOf(held)).toHaveLength(1)
    expect(await written(row.id, 'note')).toBe(2)
    expect(await written(row.id, 'document')).toBe(1)
  })

  it('an opt-in turned on later lands on the next delivery', async () => {
    const start = nextDay()
    const row = await recorder('granola', true)
    const claim = note1(start, { typedNotes: 'Strong founder.' })
    const first = valueOf(await log(row, claim))
    expect(await carriedOf(first.interactionId)).toEqual([])
    await optIn(row, { typed_notes: true })
    valueOf(await log(row, claim))
    expect((await carriedOf(first.interactionId)).map((c) => c.role)).toEqual([
      'typed_notes',
    ])
    expect(await written(row.id, 'note')).toBe(2)
  })

  it('from a webhook recorder, with no connection, stores no private extras', async () => {
    const row = await recorder('fathom', false)
    const out = valueOf(
      await log(
        row,
        note1(nextDay(), {
          typedNotes: 'Strong founder.',
          transcript: 'Maya: hello',
        }),
      ),
    )
    expect(out.outcome).toBe('born')
    expect(await written(row.id, 'note')).toBe(1)
    expect(await written(row.id, 'document')).toBe(0)
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
    await optIn(row, { typed_notes: true })
    valueOf(
      await log(
        row,
        note1(start, {
          calendarEventId: `gcal-${start}`,
          typedNotes: 'Strong founder.',
        }),
      ),
    )
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
    await optIn(row, { typed_notes: true })
    const born = valueOf(
      await log(row, note1(start, { typedNotes: 'Strong founder.' })),
    )
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
