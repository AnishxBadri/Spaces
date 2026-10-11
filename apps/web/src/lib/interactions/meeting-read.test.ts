import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  company,
  document,
  entity,
  entityAlias,
  interaction,
  interactionDocument,
  interactionEntity,
  interactionStat,
  note,
  person,
  suggestion,
} from '@spaces/db/schema'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import { and, eq } from 'drizzle-orm'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  calendarConnectedProgram,
  dayMeetingsProgram,
  meetingDetailProgram,
  pinMeetingRecordProgram,
  unwrittenMeetingsProgram,
} from './meeting-read'

/**
 * The meeting reads: a day's external meetings with RSVP per participant
 * from `meta.rsvp`, the past meetings nobody wrote up, whether a calendar is
 * connected, the window's whole read, and the pin. (D68, D79, D80)
 */

const run = <TValue, TError>(e: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(e)

async function aCompany(name: string): Promise<string> {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function aPerson(name: string, email: string): Promise<string> {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'person', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(person).values({ entityId: ent.id })
  await db.insert(entityAlias).values({
    entityId: ent.id,
    kind: 'email',
    value: email,
    valueNorm: email.toLowerCase(),
  })
  return ent.id
}

const meta = (over: Partial<MeetingMeta> = {}): MeetingMeta => ({
  kind: 'meeting',
  ends_at: '2026-10-13T10:00:00.000Z',
  status: 'scheduled',
  conference_url: 'https://meet.google.com/abc-defg-hij',
  organizer: 'ana@flent.io',
  recurring_instance_id: null,
  rsvp: { 'ana@flent.io': 'accepted', 'ben@flent.io': 'declined' },
  ...over,
})

async function aMeeting(input: {
  subject: string | null
  at: string
  meta: MeetingMeta
  records: Array<string>
  noteId?: string
}): Promise<string> {
  const [row] = await db
    .insert(interaction)
    .values({
      kind: 'meeting',
      subject: input.subject,
      occurredAt: new Date(input.at),
      meta: input.meta,
      ...(input.noteId === undefined ? {} : { noteId: input.noteId }),
    })
    .returning({ id: interaction.id })
  for (const entityId of input.records)
    await db
      .insert(interactionEntity)
      .values({ interactionId: row.id, entityId })
  return row.id
}

async function aDocument(name: string, url: string | null): Promise<string> {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(document).values({ entityId: ent.id, filename: name, url })
  return ent.id
}

describe('dayMeetingsProgram', () => {
  it('lists the day’s meetings in time order with RSVP per participant, records and artifact roles', async () => {
    const flent = await aCompany('Flent')
    const ana = await aPerson('Ana Reyes', 'ana@flent.io')
    const second = await aMeeting({
      subject: 'Flent follow-up',
      at: '2026-10-13T14:00:00.000Z',
      meta: meta({ ends_at: '2026-10-13T14:30:00.000Z' }),
      records: [flent, ana],
    })
    const first = await aMeeting({
      subject: 'Flent intro',
      at: '2026-10-13T09:30:00.000Z',
      meta: meta(),
      records: [flent, ana],
    })
    // The next day: outside the window.
    await aMeeting({
      subject: 'Elsewhere',
      at: '2026-10-14T09:30:00.000Z',
      meta: meta(),
      records: [flent],
    })
    const transcript = await aDocument('intro transcript.txt', null)
    await db.insert(interactionDocument).values({
      interactionId: first,
      documentId: transcript,
      role: 'transcript',
    })

    const day = await run(
      dayMeetingsProgram(
        new Date('2026-10-13T00:00:00.000Z'),
        new Date('2026-10-14T00:00:00.000Z'),
      ),
    )
    expect(day.map((m) => m.id)).toEqual([first, second])
    expect(day[0]).toMatchObject({
      title: 'Flent intro',
      startsAt: '2026-10-13T09:30:00.000Z',
      endsAt: '2026-10-13T10:00:00.000Z',
      cancelled: false,
      artifacts: ['transcript'],
      noteId: null,
    })
    // The organizer first, named by the person record holding the address;
    // an address no record holds is printed as itself.
    expect(day[0].participants).toEqual([
      { email: 'ana@flent.io', name: 'Ana Reyes', rsvp: 'accepted' },
      { email: 'ben@flent.io', name: null, rsvp: 'declined' },
    ])
    expect(day[0].records.map((r) => r.name)).toEqual(['Ana Reyes', 'Flent'])
  })

  it('keeps a cancelled meeting, marked', async () => {
    const flent = await aCompany('Flent')
    await aMeeting({
      subject: 'Moved',
      at: '2026-11-03T11:00:00.000Z',
      meta: meta({ status: 'cancelled' }),
      records: [flent],
    })
    const day = await run(
      dayMeetingsProgram(
        new Date('2026-11-03T00:00:00.000Z'),
        new Date('2026-11-04T00:00:00.000Z'),
      ),
    )
    expect(day).toHaveLength(1)
    expect(day[0].cancelled).toBe(true)
  })
})

describe('unwrittenMeetingsProgram', () => {
  it('lists past, uncancelled meetings with no write-up, and nothing ahead', async () => {
    const flent = await aCompany('Flent')
    const now = new Date('2027-03-13T12:00:00.000Z')
    const past = await aMeeting({
      subject: 'Flent intro',
      at: '2027-03-12T09:00:00.000Z',
      meta: meta({ ends_at: '2027-03-12T09:30:00.000Z' }),
      records: [flent],
    })
    await aMeeting({
      subject: 'Ahead',
      at: '2027-03-14T09:00:00.000Z',
      meta: meta({ ends_at: '2027-03-14T09:30:00.000Z' }),
      records: [flent],
    })
    await aMeeting({
      subject: 'Cancelled',
      at: '2027-03-11T09:00:00.000Z',
      meta: meta({ ends_at: '2027-03-11T09:30:00.000Z', status: 'cancelled' }),
      records: [flent],
    })
    const [n] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: 'Written' })
      .returning({ id: entity.id })
    await db.insert(note).values({ entityId: n.id, authorId: FIXTURE_ACTOR.id })
    await aMeeting({
      subject: 'Written',
      at: '2027-03-10T09:00:00.000Z',
      meta: meta({ ends_at: '2027-03-10T09:30:00.000Z' }),
      records: [flent],
      noteId: n.id,
    })

    expect(await run(unwrittenMeetingsProgram(now))).toEqual([
      {
        id: past,
        title: 'Flent intro',
        startsAt: '2027-03-12T09:00:00.000Z',
        record: 'Flent',
      },
    ])
  })
})

describe('calendarConnectedProgram', () => {
  it('answers from a live Google Calendar connection', async () => {
    expect(await run(calendarConnectedProgram())).toBe(false)
    await db.insert(accountConnection).values({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product: 'drive',
      externalEmail: 'fixture@fund.example',
      tokensEnc: Buffer.from('x'),
    })
    expect(await run(calendarConnectedProgram())).toBe(false)
    await db.insert(accountConnection).values({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product: 'calendar',
      externalEmail: 'fixture@fund.example',
      tokensEnc: Buffer.from('x'),
    })
    expect(await run(calendarConnectedProgram())).toBe(true)
  })
})

describe('meetingDetailProgram', () => {
  it('reads the window: link, RSVPs, records, artifacts by role and the open suggestions citing it', async () => {
    const flent = await aCompany('Flent')
    const ana = await aPerson('Ana Reyes', 'ana@flent.io')
    const id = await aMeeting({
      subject: 'Flent intro',
      at: '2026-10-13T09:30:00.000Z',
      meta: meta(),
      records: [flent, ana],
    })
    const transcript = await aDocument('intro transcript.txt', null)
    const recording = await aDocument(
      'Recording',
      'https://fathom.video/calls/42',
    )
    await db.insert(interactionDocument).values([
      { interactionId: id, documentId: transcript, role: 'transcript' },
      { interactionId: id, documentId: recording, role: 'recording_link' },
    ])
    await db.insert(suggestion).values([
      {
        entityId: flent,
        kind: 'task',
        payload: { title: 'Send the deck', due: null, entity_id: flent },
        refs: [`interaction:${id}`],
        proposedByType: 'system',
      },
      {
        entityId: flent,
        kind: 'task',
        payload: { title: 'Elsewhere', due: null, entity_id: flent },
        refs: ['interaction:00000000-0000-4000-8000-000000000000'],
        proposedByType: 'system',
      },
    ])

    const detail = await run(meetingDetailProgram(FIXTURE_ACTOR, id))
    expect(detail).toMatchObject({
      title: 'Flent intro',
      conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      cancelled: false,
      note: null,
    })
    expect(detail.participants.map((p) => [p.name ?? p.email, p.rsvp])).toEqual(
      [
        ['Ana Reyes', 'accepted'],
        ['ben@flent.io', 'declined'],
      ],
    )
    expect(
      detail.artifacts.map((a) => ({ role: a.role, name: a.name, url: a.url })),
    ).toEqual([
      { role: 'transcript', name: 'intro transcript.txt', url: null },
      {
        role: 'recording_link',
        name: 'Recording',
        url: 'https://fathom.video/calls/42',
      },
    ])
    expect(detail.suggestions).toEqual([
      expect.objectContaining({ kind: 'task', summary: 'Send the deck' }),
    ])
  })

  it('refuses an interaction that is not a meeting', async () => {
    const [row] = await db
      .insert(interaction)
      .values({ kind: 'call', occurredAt: new Date() })
      .returning({ id: interaction.id })
    const failure = await run(
      Effect.flip(meetingDetailProgram(FIXTURE_ACTOR, row.id)),
    )
    expect(failure._tag).toBe('MeetingNotFound')
  })
})

describe('pinMeetingRecordProgram', () => {
  it('adds one manual edge, once, and rolls the record’s interaction stats', async () => {
    const flent = await aCompany('Flent')
    const deal = await aCompany('Flent seed')
    const id = await aMeeting({
      subject: 'Flent intro',
      at: '2026-10-01T09:30:00.000Z',
      meta: meta({ ends_at: '2026-10-01T10:00:00.000Z' }),
      records: [flent],
    })
    expect(await run(pinMeetingRecordProgram(id, deal))).toEqual({
      pinned: true,
    })
    expect(await run(pinMeetingRecordProgram(id, deal))).toEqual({
      pinned: false,
    })
    const edges = await db
      .select()
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, id))
    expect(edges.map((e) => e.entityId).sort()).toEqual([flent, deal].sort())
    const stat = await db
      .select({ lastId: interactionStat.lastId })
      .from(interactionStat)
      .where(
        and(
          eq(interactionStat.entityId, deal),
          eq(interactionStat.kind, 'meeting'),
        ),
      )
    expect(stat).toEqual([{ lastId: id }])
  })
})
