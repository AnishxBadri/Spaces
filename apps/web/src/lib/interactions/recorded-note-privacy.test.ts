import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { chunk, document, interactionDocument, note } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { storage } from '@spaces/core/writes/storage'
import { assembleProgram } from '@spaces/core/writes/context/assemble'
import { SimilarLaneLive } from '#/lib/ai/similar'
import { birthDealProgram } from '#/lib/deals/birth'
import { documentPreviewCard } from '#/lib/documents/preview-card'
import { recordDocumentRows } from '#/lib/documents/record-files'
import { searchAllProgram } from '#/lib/search/query'
import {
  GRANOLA_URL,
  callTag,
  carried,
  deliver,
  flent,
  founderCall,
  granola,
  granolaNote,
} from '#/test/recorded-note'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { meetingDetailProgram } from './meeting-read'
import { noteRecorderLinkProgram } from './recorder-links'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * What a Granola note becomes, read by its member and by a partner (D78):
 * the write-up is everyone's, with "Open in Granola"; the opted-in typed
 * notes and transcript are the member's alone, on every read path a private
 * note already is — each asserted on its own.
 */

const OWNER = FIXTURE_ACTOR
const PARTNER = {
  id: 'member-partner',
  name: 'Priya',
  email: 'priya@spaces.test',
  emailVerified: true,
}
const TYPED = 'Quokkafounder grit'
const SPOKEN = 'Wombatcloses in March'
const shas = new Set<string>()

beforeAll(async () => {
  await db.insert(user).values(PARTNER)
})

afterEach(async () => {
  for (const sha of shas) await storage().delete(sha)
  shas.clear()
})

/** A synced founder call with Granola's note, both opt-ins on. */
async function fixture() {
  const tag = callTag()
  const company = await flent(tag)
  const open = await Effect.runPromise(
    birthDealProgram({
      name: 'Flent seed',
      companyId: company,
      actorId: OWNER.id,
      source: 'manual',
    }),
  )
  await Effect.runPromise(
    birthDealProgram({
      name: 'Flent pre-seed',
      companyId: company,
      stage: 'passed',
      actorId: OWNER.id,
      source: 'manual',
    }),
  )
  const start = new Date(Date.now() - 24 * 3_600_000)
  const meeting = await founderCall(tag, start)
  const row = await granola({ typed_notes: true, transcript: true })
  await deliver(
    row,
    granolaNote(tag, start, {
      typedNotes: `${TYPED} — would back again.`,
      transcript: `Maya: ${SPOKEN}.`,
    }),
  )
  const { writeUp, typed } = await carried(meeting)
  const transcript = (
    await db
      .select({ id: document.entityId, sha: document.blobSha })
      .from(interactionDocument)
      .innerJoin(
        document,
        eq(document.entityId, interactionDocument.documentId),
      )
      .where(
        and(
          eq(interactionDocument.interactionId, meeting),
          eq(interactionDocument.role, 'transcript'),
        ),
      )
  ).at(0)
  if (writeUp === null || typed === null || transcript === undefined)
    throw new Error('the note did not land')
  if (transcript.sha !== null) shas.add(transcript.sha)
  // What the extraction worker writes, which the queue stub never runs.
  await db
    .update(document)
    .set({
      extractedText: `Maya: ${SPOKEN}.`,
      tsv: sql`to_tsvector('english', ${`Maya: ${SPOKEN}.`})`,
      extractionStatus: 'done',
    })
    .where(eq(document.entityId, transcript.id))
  await db.insert(chunk).values({
    entityId: transcript.id,
    sourceKind: 'document',
    idx: 0,
    text: `Maya: ${SPOKEN}.`,
  })
  return {
    company,
    deal: open.id,
    meeting,
    writeUp,
    typed,
    transcript: transcript.id,
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Viewer = { id: string }

const hits = async (viewer: Viewer, q: string) =>
  (await Effect.runPromise(searchAllProgram({ userId: viewer.id, q }))).map(
    (h) => h.id,
  )

/** Each read path: whether `viewer` reaches the typed notes and the transcript there. */
const READERS: ReadonlyArray<{
  name: string
  reaches: (viewer: Viewer, f: Fixture) => Promise<boolean>
}> = [
  {
    name: 'the Files tab',
    reaches: async (viewer, f) =>
      (await recordDocumentRows(viewer.id, f.company)).some(
        (d) => d.id === f.transcript,
      ),
  },
  {
    name: 'the preview route',
    reaches: async (viewer, f) =>
      (await documentPreviewCard(viewer, f.transcript)) !== null,
  },
  {
    name: 'Cmd-K, for the typed notes',
    reaches: async (viewer, f) =>
      (await hits(viewer, 'Quokkafounder')).includes(f.typed),
  },
  {
    name: 'Cmd-K, for the transcript',
    reaches: async (viewer, f) =>
      (await hits(viewer, 'Wombatcloses')).includes(f.transcript),
  },
  {
    name: 'the context assembler',
    reaches: async (viewer, f) => {
      const text = JSON.stringify(
        await Effect.runPromise(
          assembleProgram(
            { entityId: f.company },
            {
              user: viewer,
              asOf: new Date().toISOString(),
              budgetChars: 16_000,
              taskText: `${TYPED} ${SPOKEN}`,
            },
          ).pipe(Effect.provide(SimilarLaneLive)),
        ),
      )
      // The write-up is everyone's.
      expect(text).toContain('Raising a seed')
      const typed = text.includes('Quokkafounder')
      expect(text.includes('Wombatcloses')).toBe(typed)
      return typed
    },
  },
]

describe('a Granola note, reader by reader (D78)', () => {
  for (const reader of READERS)
    it(`is the member's alone on ${reader.name}`, async () => {
      const f = await fixture()
      expect(await reader.reaches(OWNER, f)).toBe(true)
      expect(await reader.reaches(PARTNER, f)).toBe(false)
    })

  it('shares the write-up with everyone', async () => {
    const f = await fixture()
    const shared = (
      await db
        .select({ visibility: note.visibility, authorId: note.authorId })
        .from(note)
        .where(eq(note.entityId, f.writeUp))
    ).at(0)
    expect(shared).toEqual({ visibility: 'shared', authorId: OWNER.id })
    expect(await hits(PARTNER, 'Raising seed')).toContain(f.writeUp)
  })
})

describe('the meeting window', () => {
  it('offers Open note with Open in Granola, and the member alone sees the typed notes and transcript', async () => {
    const f = await fixture()
    const mine = await Effect.runPromise(meetingDetailProgram(OWNER, f.meeting))
    expect(mine.note).toEqual({
      id: f.writeUp,
      title: 'Flent — founder call',
      openIn: { provider: 'Granola', url: GRANOLA_URL },
    })
    expect(mine.notes).toEqual([
      {
        id: f.typed,
        title: 'Typed notes · Granola',
        role: 'typed_notes',
        private: true,
        openIn: { provider: 'Granola', url: GRANOLA_URL },
      },
    ])
    expect(mine.artifacts.map((a) => [a.role, a.documentId])).toEqual([
      ['transcript', f.transcript],
    ])

    const theirs = await Effect.runPromise(
      meetingDetailProgram(PARTNER, f.meeting),
    )
    expect(theirs.note?.openIn).toEqual({
      provider: 'Granola',
      url: GRANOLA_URL,
    })
    expect(theirs.notes).toEqual([])
    expect(theirs.artifacts).toEqual([])
  })

  it("links the attendees' records and the company's open deal, never a closed one", async () => {
    const f = await fixture()
    const detail = await Effect.runPromise(
      meetingDetailProgram(OWNER, f.meeting),
    )
    expect(detail.records.map((r) => [r.kind, r.name]).sort()).toEqual([
      ['company', 'Flent'],
      ['deal', 'Flent seed'],
      ['person', 'Maya Rao'],
    ])
    expect(detail.records.find((r) => r.kind === 'deal')?.id).toBe(f.deal)
  })
})

describe("the note's head", () => {
  it('opens the note at Granola', async () => {
    const f = await fixture()
    expect(await Effect.runPromise(noteRecorderLinkProgram(f.writeUp))).toEqual(
      { provider: 'Granola', url: GRANOLA_URL },
    )
  })
})
