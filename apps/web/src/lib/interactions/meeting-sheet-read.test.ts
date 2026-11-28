import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entityAlias,
  interaction,
  interactionEntity,
  person,
} from '@spaces/db/schema'
import type {
  InteractionKind,
  MeetingMeta,
} from '@spaces/db/schema/interactions'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { meetingSheetProgram } from './meeting-sheet-read'

/**
 * The sheet's `FIRST MEETING` and `NEW` are decided by what was stored
 * before the meeting's start: an earlier meeting with the company, an
 * earlier interaction with the person. What comes after never counts.
 */

const reader = { id: FIXTURE_ACTOR.id }

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

const meta = (
  at: string,
  rsvp: MeetingMeta['rsvp'],
  status: MeetingMeta['status'] = 'scheduled',
): MeetingMeta => ({
  kind: 'meeting',
  ends_at: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
  status,
  conference_url: null,
  organizer: Object.keys(rsvp).at(0) ?? null,
  recurring_instance_id: null,
  rsvp,
})

async function anInteraction(input: {
  kind: InteractionKind
  at: string
  records: Array<string>
  meta?: MeetingMeta
}): Promise<string> {
  const [row] = await db
    .insert(interaction)
    .values({
      kind: input.kind,
      subject: `${input.kind} at ${input.at}`,
      occurredAt: new Date(input.at),
      ...(input.meta === undefined ? {} : { meta: input.meta }),
    })
    .returning({ id: interaction.id })
  for (const entityId of input.records)
    await db
      .insert(interactionEntity)
      .values({ interactionId: row.id, entityId })
  return row.id
}

const sheet = (id: string) => Effect.runPromise(meetingSheetProgram(reader, id))

const AT = '2026-10-15T11:30:00.000Z'

describe('meetingSheetProgram: FIRST MEETING', () => {
  it('is the first meeting when nothing with its company came before, whatever comes after', async () => {
    const flent = await aCompany('Flent')
    const id = await anInteraction({
      kind: 'meeting',
      at: AT,
      records: [flent],
      meta: meta(AT, {}),
    })
    // Later meetings and a call after it do not take the stamp away.
    await anInteraction({
      kind: 'meeting',
      at: '2026-10-20T11:30:00.000Z',
      records: [flent],
      meta: meta('2026-10-20T11:30:00.000Z', {}),
    })
    await anInteraction({
      kind: 'call',
      at: '2026-10-16T09:00:00.000Z',
      records: [flent],
    })
    // An email before is not a meeting.
    await anInteraction({
      kind: 'email',
      at: '2026-10-01T09:00:00.000Z',
      records: [flent],
    })
    expect((await sheet(id)).firstMeeting).toBe(true)
  })

  it('is not when an earlier meeting or call was with its company; a cancelled one does not count', async () => {
    const flent = await aCompany('Flent')
    const lattice = await aCompany('Lattice')
    const id = await anInteraction({
      kind: 'meeting',
      at: AT,
      records: [flent],
      meta: meta(AT, {}),
    })
    const other = await anInteraction({
      kind: 'meeting',
      at: AT,
      records: [lattice],
      meta: meta(AT, {}),
    })
    await anInteraction({
      kind: 'call',
      at: '2026-10-02T09:00:00.000Z',
      records: [flent],
    })
    await anInteraction({
      kind: 'meeting',
      at: '2026-10-03T09:00:00.000Z',
      records: [lattice],
      meta: meta('2026-10-03T09:00:00.000Z', {}, 'cancelled'),
    })
    expect((await sheet(id)).firstMeeting).toBe(false)
    expect((await sheet(other)).firstMeeting).toBe(true)
  })

  it('carries no stamp with no company to be first with', async () => {
    const id = await anInteraction({
      kind: 'meeting',
      at: AT,
      records: [],
      meta: meta(AT, {}),
    })
    expect((await sheet(id)).firstMeeting).toBe(false)
  })
})

describe('meetingSheetProgram: NEW', () => {
  it('marks a person new only when nothing with them came before the start', async () => {
    const flent = await aCompany('Flent')
    const ana = await aPerson('Ana Reyes', 'ana@flent.io')
    const ben = await aPerson('Ben Ito', 'ben@flent.io')
    await aPerson('Cara Lim', 'cara@flent.io')
    const id = await anInteraction({
      kind: 'meeting',
      at: AT,
      records: [flent, ana, ben],
      meta: meta(AT, {
        'ana@flent.io': 'accepted',
        'ben@flent.io': 'tentative',
        'cara@flent.io': 'needs_action',
        'dev@flent.io': 'declined',
        [FIXTURE_ACTOR.email]: 'accepted',
      }),
    })
    // Ana wrote before; Ben only after.
    await anInteraction({
      kind: 'email',
      at: '2026-10-10T09:00:00.000Z',
      records: [ana],
    })
    await anInteraction({
      kind: 'email',
      at: '2026-10-16T09:00:00.000Z',
      records: [ben],
    })
    // Cara was invited to an earlier meeting; Dev to a later one only.
    await anInteraction({
      kind: 'meeting',
      at: '2026-10-05T09:00:00.000Z',
      records: [],
      meta: meta('2026-10-05T09:00:00.000Z', { 'cara@flent.io': 'accepted' }),
    })
    await anInteraction({
      kind: 'meeting',
      at: '2026-10-25T09:00:00.000Z',
      records: [],
      meta: meta('2026-10-25T09:00:00.000Z', { 'dev@flent.io': 'accepted' }),
    })
    const people = (await sheet(id)).people
    const isNew = Object.fromEntries(people.map((p) => [p.email, p.new]))
    expect(isNew).toEqual({
      'ana@flent.io': false,
      'ben@flent.io': true,
      'cara@flent.io': false,
      'dev@flent.io': true,
      // A member is never new.
      [FIXTURE_ACTOR.email]: false,
    })
    expect(people.find((p) => p.email === FIXTURE_ACTOR.email)?.you).toBe(true)
    expect(people.find((p) => p.email === 'ana@flent.io')?.host).toBe(true)
  })
})
