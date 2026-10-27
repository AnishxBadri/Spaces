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
  integration,
  interactionStat,
  note,
  person,
  suggestion,
} from '@spaces/db/schema'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import { and, eq } from 'drizzle-orm'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  calendarConnectedProgram,
  dayMeetingsProgram,
  meetingDetailProgram,
  meetingListProgram,
  pinMeetingRecordProgram,
  unwrittenMeetingsProgram,
} from './meeting-read'

/**
 * The meeting reads: a day's external meetings with RSVP per participant
 * from `meta.rsvp`, the past meetings nobody wrote up, whether a calendar is
 * connected, the window's whole read, and the pin.
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

  it('names who outside the workspace each meeting is with, never a member', async () => {
    const [me] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, FIXTURE_ACTOR.id))
    const priya = await aPerson('Priya Raman', 'priya@vayu.in')
    await aMeeting({
      subject: 'Vayu',
      at: '2026-11-05T11:00:00.000Z',
      meta: meta({
        organizer: me.email,
        rsvp: {
          [me.email]: 'accepted',
          'priya@vayu.in': 'accepted',
          'raj@vayu.in': 'tentative',
        },
      }),
      records: [priya],
    })
    const day = await run(
      dayMeetingsProgram(
        new Date('2026-11-05T00:00:00.000Z'),
        new Date('2026-11-06T00:00:00.000Z'),
      ),
    )
    // The member organizes and is left out; an unnamed address is itself.
    expect(day[0].external).toEqual(['Priya Raman', 'raj@vayu.in'])
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
        who: 'ana@flent.io',
        sensitive: null,
      },
    ])
  })

  it('names the first participant outside the workspace and a sensitive record', async () => {
    const flent = await aCompany('Flent')
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, flent))
    const ben = await aPerson('Ben Okafor', 'ben@flent.io')
    const [member] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, FIXTURE_ACTOR.id))
    await aMeeting({
      subject: 'Flent follow-up',
      at: '2027-03-12T09:00:00.000Z',
      // The member organizes; the reader is never who the meeting was with.
      meta: meta({
        ends_at: '2027-03-12T09:30:00.000Z',
        organizer: member.email,
        rsvp: { [member.email]: 'accepted', 'ben@flent.io': 'accepted' },
      }),
      records: [flent, ben],
    })
    // The file's other meetings share the database; read this one.
    const row = (
      await run(unwrittenMeetingsProgram(new Date('2027-03-13T12:00:00.000Z')))
    ).find((m) => m.title === 'Flent follow-up')
    expect(row?.who).toBe('Ben Okafor')
    expect(row?.sensitive).toBe('Flent')
  })
})

/** A write-up note; `source` marks it written by an integration. */
async function aNote(input: {
  title: string
  authorId: string
  visibility?: 'shared' | 'private'
  source?: string
}): Promise<string> {
  const [n] = await db
    .insert(entity)
    .values({
      kind: 'note',
      canonicalName: input.title,
      ...(input.source === undefined
        ? {}
        : { sourceClass: 'integration' as const, sourceRef: input.source }),
    })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: n.id,
    authorId: input.authorId,
    title: input.title,
    visibility: input.visibility ?? 'shared',
  })
  return n.id
}

describe('meetingListProgram', () => {
  const now = new Date('2027-03-15T12:00:00.000Z')
  const until = new Date('2027-03-29T00:00:00.000Z')
  const reader = { id: FIXTURE_ACTOR.id, email: FIXTURE_ACTOR.email }

  it('splits upcoming from past: upcoming earliest first, past unwritten first then newest, cancelled in place', async () => {
    const flent = await aCompany('Flent')
    const at = (iso: string, over: Partial<MeetingMeta> = {}) =>
      meta({
        ends_at: new Date(Date.parse(iso) + 1_800_000).toISOString(),
        ...over,
      })
    const later = await aMeeting({
      subject: 'Tuesday call two',
      at: '2027-03-16T15:00:00.000Z',
      meta: at('2027-03-16T15:00:00.000Z'),
      records: [flent],
    })
    const sooner = await aMeeting({
      subject: 'Tuesday call one',
      at: '2027-03-16T10:00:00.000Z',
      meta: at('2027-03-16T10:00:00.000Z'),
      records: [flent],
    })
    // Past the horizon: not this week or next.
    await aMeeting({
      subject: 'Next month',
      at: '2027-04-02T10:00:00.000Z',
      meta: at('2027-04-02T10:00:00.000Z'),
      records: [],
    })
    const written = await aMeeting({
      subject: 'Written yesterday',
      at: '2027-03-14T10:00:00.000Z',
      meta: at('2027-03-14T10:00:00.000Z'),
      records: [],
      noteId: await aNote({ title: 'Notes', authorId: FIXTURE_ACTOR.id }),
    })
    const cancelled = await aMeeting({
      subject: 'Cancelled',
      at: '2027-03-13T10:00:00.000Z',
      meta: at('2027-03-13T10:00:00.000Z', { status: 'cancelled' }),
      records: [],
    })
    const oldUnwritten = await aMeeting({
      subject: 'Old unwritten',
      at: '2027-03-08T10:00:00.000Z',
      meta: at('2027-03-08T10:00:00.000Z'),
      records: [],
    })
    const newUnwritten = await aMeeting({
      subject: 'New unwritten',
      at: '2027-03-12T10:00:00.000Z',
      meta: at('2027-03-12T10:00:00.000Z'),
      records: [],
    })

    const list = await run(meetingListProgram(reader, now, until))
    // Isolation is per file: keep to this test's rows, in the order read.
    const ours = new Set([
      sooner,
      later,
      written,
      cancelled,
      oldUnwritten,
      newUnwritten,
    ])
    const ids = (rows: ReadonlyArray<{ id: string }>) =>
      rows.map((m) => m.id).filter((id) => ours.has(id))
    expect(ids(list.upcoming)).toEqual([sooner, later])
    expect(ids(list.past)).toEqual([
      newUnwritten,
      oldUnwritten,
      written,
      cancelled,
    ])
    expect(list.past.find((m) => m.id === cancelled)?.cancelled).toBe(true)
    expect(list.earlier).toBe(0)
    expect(
      list.upcoming.find((m) => m.id === sooner)?.records.map((r) => r.name),
    ).toEqual(['Flent'])
  })

  it('reads the write-up through canRead: written, via the integration that wrote it, or private', async () => {
    const [other] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        name: 'Other Partner',
        email: `${crypto.randomUUID()}@fund.example`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: user.id })
    const [granola] = await db
      .insert(integration)
      .values({
        capabilityId: 'granola',
        version: '1.0.0',
        enabled: true,
        manifest: { id: 'granola', name: 'Granola' },
      })
      .returning({ id: integration.id })
    const mine = await aMeeting({
      subject: 'Mine',
      at: '2027-03-14T10:00:00.000Z',
      meta: meta({ ends_at: '2027-03-14T10:30:00.000Z' }),
      records: [],
      noteId: await aNote({ title: 'A', authorId: FIXTURE_ACTOR.id }),
    })
    const recorded = await aMeeting({
      subject: 'Recorded',
      at: '2027-03-13T10:00:00.000Z',
      meta: meta({ ends_at: '2027-03-13T10:30:00.000Z' }),
      records: [],
      noteId: await aNote({
        title: 'B',
        authorId: FIXTURE_ACTOR.id,
        source: granola.id,
      }),
    })
    const hidden = await aMeeting({
      subject: 'Hidden',
      at: '2027-03-12T10:00:00.000Z',
      meta: meta({ ends_at: '2027-03-12T10:30:00.000Z' }),
      records: [],
      noteId: await aNote({
        title: 'C',
        authorId: other.id,
        visibility: 'private',
        source: granola.id,
      }),
    })

    const list = await run(meetingListProgram(reader, now, until))
    const state = (id: string) => {
      const m = list.past.find((p) => p.id === id)
      return m ? { writeUp: m.writeUp, via: m.via } : null
    }
    expect(state(mine)).toEqual({ writeUp: 'written', via: null })
    expect(state(recorded)).toEqual({ writeUp: 'written', via: 'Granola' })
    // The row stays: the meeting is shared, only its write-up is not.
    expect(state(hidden)).toEqual({ writeUp: 'private', via: null })
  })

  it('marks the reader’s meetings by login address or a connected account, with their answer', async () => {
    const login = `${crypto.randomUUID()}@fund.example`
    const [partner] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        name: 'Partner',
        email: login,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: user.id })
    // Not a calendar: `calendarConnectedProgram` below reads this file's rows.
    await db.insert(accountConnection).values({
      userId: partner.id,
      provider: 'google',
      product: 'drive',
      externalEmail: 'Partner@Elsewhere.example',
      tokensEnc: Buffer.from('x'),
    })
    const byLogin = await aMeeting({
      subject: 'By login',
      at: '2027-03-16T10:00:00.000Z',
      meta: meta({
        ends_at: '2027-03-16T10:30:00.000Z',
        rsvp: { [login.toUpperCase()]: 'tentative' },
      }),
      records: [],
    })
    const byAccount = await aMeeting({
      subject: 'By account',
      at: '2027-03-17T10:00:00.000Z',
      meta: meta({
        ends_at: '2027-03-17T10:30:00.000Z',
        rsvp: { 'partner@elsewhere.example': 'accepted' },
      }),
      records: [],
    })
    const organized = await aMeeting({
      subject: 'Organized',
      at: '2027-03-18T10:00:00.000Z',
      meta: meta({
        ends_at: '2027-03-18T10:30:00.000Z',
        organizer: login,
      }),
      records: [],
    })
    const theirs = await aMeeting({
      subject: 'Theirs',
      at: '2027-03-19T10:00:00.000Z',
      meta: meta({ ends_at: '2027-03-19T10:30:00.000Z' }),
      records: [],
    })

    const list = await run(
      meetingListProgram({ id: partner.id, email: login }, now, until),
    )
    const of = (id: string) => {
      const m = list.upcoming.find((u) => u.id === id)
      return m ? { mine: m.mine, myRsvp: m.myRsvp } : null
    }
    expect(of(byLogin)).toEqual({ mine: true, myRsvp: 'tentative' })
    expect(of(byAccount)).toEqual({ mine: true, myRsvp: 'accepted' })
    expect(of(organized)).toEqual({ mine: true, myRsvp: null })
    expect(of(theirs)).toEqual({ mine: false, myRsvp: null })
  })
  it('counts every tab on the server, counts each write-up’s tasks, and leaves the reader out of the people', async () => {
    const login = `${crypto.randomUUID()}@fund.example`
    const [partner] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        name: 'Counting Partner',
        email: login,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: user.id })
    const counter = { id: partner.id, email: login }
    const before = await run(meetingListProgram(counter, now, until))
    const flent = await aCompany('Flent')
    const at = (iso: string, over: Partial<MeetingMeta> = {}) =>
      meta({
        ends_at: new Date(Date.parse(iso) + 1_800_000).toISOString(),
        ...over,
      })
    // Upcoming and the reader's: they answered, in another case.
    const ahead = await aMeeting({
      subject: 'Ahead',
      at: '2027-03-20T10:00:00.000Z',
      meta: at('2027-03-20T10:00:00.000Z', {
        rsvp: { 'ana@flent.io': 'accepted', [login.toUpperCase()]: 'accepted' },
      }),
      records: [],
    })
    // Past, unwritten.
    await aMeeting({
      subject: 'Unwritten',
      at: '2027-03-10T10:00:00.000Z',
      meta: at('2027-03-10T10:00:00.000Z'),
      records: [],
    })
    // Past, written, and the reader organized it.
    const written = await aMeeting({
      subject: 'Written',
      at: '2027-03-11T10:00:00.000Z',
      meta: at('2027-03-11T10:00:00.000Z', { organizer: login }),
      records: [],
      noteId: await aNote({ title: 'Write-up', authorId: FIXTURE_ACTOR.id }),
    })
    // Past and cancelled: no write-up owed.
    await aMeeting({
      subject: 'Dropped',
      at: '2027-03-12T10:00:00.000Z',
      meta: at('2027-03-12T10:00:00.000Z', { status: 'cancelled' }),
      records: [],
    })
    const task = (status: 'open' | 'accepted' | 'rejected') => ({
      entityId: flent,
      kind: 'task' as const,
      payload: { title: `A ${status} task`, due: null, entity_id: flent },
      refs: [`interaction:${written}`],
      proposedByType: 'system' as const,
      status,
      ...(status === 'open'
        ? {}
        : { decidedBy: FIXTURE_ACTOR.id, decidedAt: new Date() }),
    })
    await db
      .insert(suggestion)
      .values([task('open'), task('accepted'), task('rejected')])

    const after = await run(meetingListProgram(counter, now, until))
    const grew = (k: keyof typeof after.counts) =>
      after.counts[k] - before.counts[k]
    expect({
      all: grew('all'),
      upcoming: grew('upcoming'),
      past: grew('past'),
      unwritten: grew('unwritten'),
      mine: grew('mine'),
    }).toEqual({ all: 4, upcoming: 1, past: 3, unwritten: 1, mine: 2 })
    expect(after.counts.all).toBe(after.counts.upcoming + after.counts.past)
    expect(after.earlier).toBe(after.counts.past - after.past.length)
    // Dismissed proposals leave the count; open and accepted stay.
    expect(after.past.find((m) => m.id === written)?.tasks).toBe(2)
    expect(
      after.upcoming
        .find((m) => m.id === ahead)
        ?.participants.map((p) => p.email),
    ).toEqual(['ana@flent.io'])
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
