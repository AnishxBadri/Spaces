import { Effect } from 'effect'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { integration, interactionEntity } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { writeIntegrationInteraction } from '@spaces/core/writes/interactions/write'
import { birthDealProgram } from '#/lib/deals/birth'
import { writeUpInteractionProgram } from '#/lib/interactions/write-up'
import {
  callTag,
  carried,
  deliver,
  flent,
  founderCall,
  granola,
  granolaNote,
} from '#/test/recorded-note'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { listRecordNotesProgram } from './list-record'
import { noteViaProgram } from './via'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * A record's From meetings lane and the via mark: the meeting's
 * write-up and its second notes, a private typed note for its author only,
 * a recorder note listed once under All though it is also filed, and the
 * mark only on what a recorder filed.
 */

const OWNER = FIXTURE_ACTOR
const PARTNER = {
  id: 'member-partner',
  name: 'Priya',
  email: 'priya@spaces.test',
  emailVerified: true,
}

beforeAll(async () => {
  await db.insert(user).values(PARTNER)
})

const run = <TValue, TError>(eff: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(eff)
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id)

/** A founder call Granola filed, typed notes opted in. */
async function granolaCall() {
  const tag = callTag()
  const company = await flent(tag)
  const start = new Date(Date.now() - 24 * 3_600_000)
  const meeting = await founderCall(tag, start)
  const row = await granola({ typed_notes: true, transcript: false })
  await deliver(
    row,
    granolaNote(tag, start, { typedNotes: 'Would back again.' }),
  )
  const { writeUp, typed } = await carried(meeting)
  if (writeUp === null || typed === null) throw new Error('nothing landed')
  return { company, meeting, writeUp, typed }
}

describe('the From meetings lane', () => {
  it("lists the meeting's write-up and the member's typed notes, the typed notes for their author alone", async () => {
    const f = await granolaCall()
    const mine = await run(listRecordNotesProgram(OWNER.id, f.company))
    expect(ids(mine.fromMeetings)).toEqual([f.writeUp, f.typed])
    const theirs = await run(listRecordNotesProgram(PARTNER.id, f.company))
    expect(ids(theirs.fromMeetings)).toEqual([f.writeUp])
    expect(ids(theirs.filed)).not.toContain(f.typed)
    expect(ids(theirs.mentions)).not.toContain(f.typed)
  })

  it('keeps a filed recorder note in Filed here as well, and out of Mentions', async () => {
    const f = await granolaCall()
    const notes = await run(listRecordNotesProgram(OWNER.id, f.company))
    // The recorder files its note on the meeting's records too.
    expect(ids(notes.filed)).toContain(f.writeUp)
    expect(ids(notes.fromMeetings)).toContain(f.writeUp)
    expect(ids(notes.mentions)).not.toContain(f.writeUp)
  })

  it("lists a hand-typed write-up first and the recorder's second note after it", async () => {
    const tag = callTag()
    const company = await flent(tag)
    const start = new Date(Date.now() - 24 * 3_600_000)
    const meeting = await founderCall(tag, start)
    await db
      .insert(interactionEntity)
      .values({ interactionId: meeting, entityId: company })
    const { noteId: typedByHand } = await run(
      writeUpInteractionProgram(OWNER.id, meeting),
    )
    const row = await granola({ typed_notes: false, transcript: false })
    await deliver(row, granolaNote(tag, start))
    const notes = await run(listRecordNotesProgram(OWNER.id, company))
    expect(notes.fromMeetings.map((n) => [n.id, n.via])).toEqual([
      [typedByHand, null],
      [expect.any(String), { tool: 'Granola', author: OWNER.name }],
    ])
    expect(notes.fromMeetings.at(1)?.title).toBe(
      `Granola notes · ${OWNER.name}`,
    )
  })

  it("reads a deal's meetings through its company, as its Interactions tab does", async () => {
    const f = await granolaCall()
    const { id: dealId } = await run(
      birthDealProgram({
        name: 'Flent seed',
        companyId: f.company,
        actorId: OWNER.id,
        source: 'manual',
      }),
    )
    const notes = await run(listRecordNotesProgram(OWNER.id, dealId))
    expect(ids(notes.fromMeetings)).toEqual([f.writeUp, f.typed])
  })

  it("leaves an email's body out: mail is not a meeting note", async () => {
    const tag = callTag()
    const company = await flent(tag)
    const gmail = (
      await db
        .insert(integration)
        .values({ capabilityId: 'gmail', version: '0.1.0' })
        .returning({ id: integration.id })
    ).at(0)
    if (!gmail) throw new Error('no gmail')
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, {
        integrationId: gmail.id,
        kind: 'email',
        messageId: `mail-${tag}@example`,
        threadId: null,
        subject: 'Flent update',
        occurredAt: new Date(),
        body: {
          title: 'Flent update',
          text: 'Closed the round.',
          authorId: OWNER.id,
          visibility: 'shared',
        },
        edges: [company],
      }),
    )
    if (written.kind !== 'written' || written.noteId === null)
      throw new Error('mail not written')
    const notes = await run(listRecordNotesProgram(OWNER.id, company))
    expect(notes.fromMeetings).toEqual([])
    expect(await run(noteViaProgram(written.noteId))).toBeNull()
  })
})

describe('the via mark', () => {
  it("names the recorder and the member on a recorder's notes", async () => {
    const f = await granolaCall()
    const via = { tool: 'Granola', author: OWNER.name }
    expect(await run(noteViaProgram(f.writeUp))).toEqual(via)
    expect(await run(noteViaProgram(f.typed))).toEqual(via)
  })
})
