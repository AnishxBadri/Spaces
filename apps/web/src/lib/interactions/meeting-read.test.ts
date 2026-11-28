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
  const reader = { id: FIXTURE_ACTOR.id, email: FIXTURE_ACTOR.email }
  /** A meeting with Ana that the reader was invited to. */
  const invited = (over: Partial<MeetingMeta> = {}) =>
    meta({
      rsvp: { 'ana@flent.io': 'accepted', [reader.email]: 'accepted' },
      ...over,
    })

  it('lists past, uncancelled meetings with no write-up, and nothing ahead', async () => {
    const flent = await aCompany('Flent')
    const now = new Date('2027-03-13T12:00:00.000Z')
    const past = await aMeeting({
      subject: 'Flent intro',
      at: '2027-03-12T09:00:00.000Z',
      meta: invited({ ends_at: '2027-03-12T09:30:00.000Z' }),
      records: [flent],
    })
    await aMeeting({
      subject: 'Ahead',
      at: '2027-03-14T09:00:00.000Z',
      meta: invited({ ends_at: '2027-03-14T09:30:00.000Z' }),
      records: [flent],
    })
    await aMeeting({
      subject: 'Cancelled',
      at: '2027-03-11T09:00:00.000Z',
      meta: invited({
        ends_at: '2027-03-11T09:30:00.000Z',
        status: 'cancelled',
      }),
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
      meta: invited({ ends_at: '2027-03-10T09:30:00.000Z' }),
      records: [flent],
      noteId: n.id,
    })

    expect(await run(unwrittenMeetingsProgram(reader, now))).toEqual([
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
      await run(
        unwrittenMeetingsProgram(reader, new Date('2027-03-13T12:00:00.000Z')),
      )
    ).find((m) => m.title === 'Flent follow-up')
    expect(row?.who).toBe('Ben Okafor')
    expect(row?.sensitive).toBe('Flent')
  })

  it('leaves out a colleague’s meeting the reader was not in', async () => {
    const kavya = await aMember('Kavya Iyer')
    const now = new Date('2027-03-13T12:00:00.000Z')
    await aMeeting({
      subject: 'Ours',
      at: '2027-03-12T09:00:00.000Z',
      meta: invited({ ends_at: '2027-03-12T09:30:00.000Z' }),
      records: [],
    })
    await aMeeting({
      subject: 'Kavya’s',
      at: '2027-03-12T10:00:00.000Z',
      meta: meta({
        ends_at: '2027-03-12T10:30:00.000Z',
        organizer: kavya.email,
        rsvp: { [kavya.email]: 'accepted', 'ana@flent.io': 'accepted' },
      }),
      records: [],
    })
    // The file's other meetings share the database; read these two.
    const titles = async (who: { id: string; email: string }) =>
      (await run(unwrittenMeetingsProgram(who, now)))
        .map((m) => m.title)
        .filter((t) => t === 'Ours' || t === 'Kavya’s')
    expect(await titles(reader)).toEqual(['Ours'])
    // Kavya sees her own and not the reader's.
    expect(await titles(kavya)).toEqual(['Kavya’s'])
  })

  it('holds a recorded meeting back for the hour after it ends', async () => {
    const recorder = await aMember('Recording Partner')
    await db.insert(accountConnection).values({
      userId: recorder.id,
      provider: 'granola',
      product: 'notes',
      externalEmail: recorder.email,
      tokensEnc: Buffer.from('x'),
    })
    // Past the list tests' horizon, so their counts never meet it.
    const recorded = await aMeeting({
      subject: 'Recorded',
      at: '2027-05-20T11:00:00.000Z',
      meta: meta({
        ends_at: '2027-05-20T11:30:00.000Z',
        rsvp: {
          [reader.email]: 'accepted',
          [recorder.email]: 'accepted',
        },
      }),
      records: [],
    })
    const listed = async (iso: string) =>
      (await run(unwrittenMeetingsProgram(reader, new Date(iso)))).some(
        (m) => m.id === recorded,
      )
    expect(await listed('2027-05-20T11:30:00.000Z')).toBe(false)
    expect(await listed('2027-05-20T12:29:59.999Z')).toBe(false)
    expect(await listed('2027-05-20T12:30:00.000Z')).toBe(true)
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

/** A member of the workspace, with their login address. */
async function aMember(name: string): Promise<{ id: string; email: string }> {
  const email = `${crypto.randomUUID()}@fund.example`
  const [row] = await db
    .insert(user)
    .values({
      id: crypto.randomUUID(),
      name,
      email,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: user.id })
  return { id: row.id, email }
}

describe('meetingListProgram', () => {
  const now = '2027-03-15T12:00:00.000Z'
  const until = '2027-03-29T00:00:00.000Z'
  const reader = { id: FIXTURE_ACTOR.id, email: FIXTURE_ACTOR.email }
  const list = (
    who: { id: string; email: string },
    tab: 'upcoming' | 'past',
    whose: 'mine' | 'everyone' = 'everyone',
    at: string = now,
  ) => run(meetingListProgram(who, { tab, whose, now: at, until }))
  const at = (iso: string, over: Partial<MeetingMeta> = {}) =>
    meta({
      ends_at: new Date(Date.parse(iso) + 1_800_000).toISOString(),
      ...over,
    })

  it('splits upcoming from past: upcoming earliest first and cancelled kept, past unwritten first then newest, cancelled left out', async () => {
    const flent = await aCompany('Flent')
    const later = await aMeeting({
      subject: 'Tuesday call two',
      at: '2027-03-16T15:00:00.000Z',
      meta: at('2027-03-16T15:00:00.000Z'),
      records: [flent],
    })
    const sooner = await aMeeting({
      subject: 'Tuesday call one',
      at: '2027-03-16T10:00:00.000Z',
      meta: at('2027-03-16T10:00:00.000Z', { status: 'cancelled' }),
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

    const [ahead, past] = [
      await list(reader, 'upcoming'),
      await list(reader, 'past'),
    ]
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
    expect(ids(ahead.rows)).toEqual([sooner, later])
    expect(ahead.rows.find((m) => m.id === sooner)?.cancelled).toBe(true)
    expect(ids(past.rows)).toEqual([newUnwritten, oldUnwritten, written])
    expect(
      past.rows.filter((m) => ours.has(m.id)).map((m) => m.unwritten),
    ).toEqual([true, true, false])
    expect(ahead.rows.find((m) => m.id === later)?.record?.name).toBe('Flent')
  })

  it('reads the write-up through canRead: written with its summary, via the integration that wrote it, or private', async () => {
    const other = await aMember('Other Partner')
    const [granola] = await db
      .insert(integration)
      .values({
        capabilityId: 'granola',
        version: '1.0.0',
        enabled: true,
        manifest: { id: 'granola', name: 'Granola' },
      })
      .returning({ id: integration.id })
    const mineNote = await aNote({ title: 'A', authorId: FIXTURE_ACTOR.id })
    await db
      .update(note)
      .set({ bodyMd: 'The bridge closes on the 30th.' })
      .where(eq(note.entityId, mineNote))
    const mine = await aMeeting({
      subject: 'Mine',
      at: '2027-03-14T10:00:00.000Z',
      meta: meta({ ends_at: '2027-03-14T10:30:00.000Z' }),
      records: [],
      noteId: mineNote,
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

    const past = await list(reader, 'past')
    const state = (id: string) => {
      const m = past.rows.find((p) => p.id === id)
      return m ? { writeUp: m.writeUp, via: m.via, summary: m.summary } : null
    }
    expect(state(mine)).toEqual({
      writeUp: 'written',
      via: null,
      summary: 'The bridge closes on the 30th.',
    })
    expect(state(recorded)).toMatchObject({
      writeUp: 'written',
      via: 'Granola',
    })
    // The row stays: the meeting is shared, only its write-up is not.
    expect(state(hidden)).toEqual({
      writeUp: 'private',
      via: null,
      summary: null,
    })
  })

  it('keeps the reader’s meetings under Mine and the team’s under Everyone, naming a colleague only where the reader is not', async () => {
    const partner = await aMember('Partner')
    const kavya = await aMember('Kavya Iyer')
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
      meta: at('2027-03-16T10:00:00.000Z', {
        rsvp: {
          [partner.email.toUpperCase()]: 'tentative',
          'ana@flent.io': 'accepted',
        },
      }),
      records: [],
    })
    const byAccount = await aMeeting({
      subject: 'By account',
      at: '2027-03-17T10:00:00.000Z',
      meta: at('2027-03-17T10:00:00.000Z', {
        rsvp: { 'partner@elsewhere.example': 'accepted' },
      }),
      records: [],
    })
    const organized = await aMeeting({
      subject: 'Organized',
      at: '2027-03-18T10:00:00.000Z',
      meta: at('2027-03-18T10:00:00.000Z', { organizer: partner.email }),
      records: [],
    })
    const theirs = await aMeeting({
      subject: 'Theirs',
      at: '2027-03-19T10:00:00.000Z',
      meta: at('2027-03-19T10:00:00.000Z', {
        rsvp: { [kavya.email]: 'accepted', 'ana@flent.io': 'accepted' },
      }),
      records: [],
    })
    const ours = [byLogin, byAccount, organized, theirs]

    const mine = await list(partner, 'upcoming', 'mine')
    const everyone = await list(partner, 'upcoming', 'everyone')
    expect(mine.rows.map((m) => m.id)).toEqual([byLogin, byAccount, organized])
    expect(mine.counts.upcoming).toBe(3)
    expect(
      everyone.rows.map((m) => m.id).filter((id) => ours.includes(id)),
    ).toEqual(ours)
    expect(everyone.counts.upcoming).toBeGreaterThanOrEqual(4)
    const row = (id: string) => everyone.rows.find((m) => m.id === id)
    expect(row(theirs)).toMatchObject({ mine: false, members: ['Kavya Iyer'] })
    // The reader is never among a row's people, nor a colleague.
    expect(row(byLogin)).toMatchObject({
      mine: true,
      members: [],
      people: ['ana@flent.io'],
    })
    expect(row(theirs)?.people).toEqual(['ana@flent.io'])
  })

  it('holds a recorded meeting out of No write-up for the hour after it ends', async () => {
    const recorder = await aMember('Recording Partner')
    await db.insert(accountConnection).values({
      userId: recorder.id,
      provider: 'granola',
      product: 'notes',
      externalEmail: recorder.email,
      tokensEnc: Buffer.from('x'),
    })
    const endsAt = '2027-03-15T11:30:00.000Z'
    const recorded = await aMeeting({
      subject: 'Recorded, just ended',
      at: '2027-03-15T11:00:00.000Z',
      meta: meta({ ends_at: endsAt, rsvp: { [recorder.email]: 'accepted' } }),
      records: [],
    })
    const plain = await aMeeting({
      subject: 'Not recorded, just ended',
      at: '2027-03-15T10:59:00.000Z',
      meta: meta({ ends_at: endsAt, rsvp: { 'ana@flent.io': 'accepted' } }),
      records: [],
    })
    const owes = async (when: string) => {
      const past = await list(reader, 'past', 'everyone', when)
      return {
        recorded: past.rows.find((m) => m.id === recorded)?.unwritten,
        plain: past.rows.find((m) => m.id === plain)?.unwritten,
        // The band sorts by the same rule: owing rows come first.
        order: past.rows
          .map((m) => m.id)
          .filter((id) => id === recorded || id === plain),
        unwritten: past.counts.unwritten,
      }
    }
    const soon = await owes('2027-03-15T12:00:00.000Z')
    const late = await owes('2027-03-15T12:30:00.000Z')
    expect(soon).toMatchObject({ recorded: false, plain: true })
    expect(soon.order).toEqual([plain, recorded])
    expect(late).toMatchObject({ recorded: true, plain: true })
    expect(late.unwritten - soon.unwritten).toBe(1)
  })

  it('lists calls in Past, and pages Past by its cursor with nothing read twice', async () => {
    const [call] = await db
      .insert(interaction)
      .values({
        kind: 'call',
        subject: 'Reference call',
        occurredAt: new Date('2027-03-14T09:00:00.000Z'),
      })
      .returning({ id: interaction.id })
    const first = await list(reader, 'past')
    expect(first.rows.find((m) => m.id === call.id)?.kind).toBe('call')
    // Enough rows for a second page.
    for (let i = 0; i < 60; i++)
      await aMeeting({
        subject: `Filler ${String(i)}`,
        at: new Date(
          Date.parse('2027-02-01T10:00:00.000Z') + i * 60_000,
        ).toISOString(),
        meta: at(
          new Date(
            Date.parse('2027-02-01T10:00:00.000Z') + i * 60_000,
          ).toISOString(),
        ),
        records: [],
        noteId: await aNote({
          title: `F${String(i)}`,
          authorId: FIXTURE_ACTOR.id,
        }),
      })
    const pageOne = await list(reader, 'past')
    expect(pageOne.nextCursor).not.toBeNull()
    const pageTwo = await run(
      meetingListProgram(reader, {
        tab: 'past',
        whose: 'everyone',
        now,
        until,
        cursor: pageOne.nextCursor ?? '',
      }),
    )
    const seen = [...pageOne.rows, ...pageTwo.rows].map((m) => m.id)
    expect(new Set(seen).size).toBe(seen.length)
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

  it('refuses an interaction that is not a meeting or a call', async () => {
    const [row] = await db
      .insert(interaction)
      .values({ kind: 'email', occurredAt: new Date() })
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
