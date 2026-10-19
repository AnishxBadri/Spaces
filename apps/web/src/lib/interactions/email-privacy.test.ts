import { createHash, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  chunk,
  document,
  emailGrant,
  entityAlias,
  entitySpace,
  integration,
  interaction,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { renderMessage } from '@spaces/sdk/testing'
import type { FakeGmailMessage } from '@spaces/sdk/testing'
import { storage } from '@spaces/core/writes/storage'
import { assembleProgram } from '@spaces/core/writes/context/assemble'
import { getRecordProgram } from '@spaces/core/writes/read/record'
import { SimilarLaneLive } from '#/lib/ai/similar'
import { documentDetailsProgram } from '#/lib/documents/details'
import { spaceInheritedSourcesProgram } from '#/lib/documents/space-sources'
import { logSyncedEmailProgram } from '#/lib/arrival/synced'
import { searchRecordsProgram } from '#/lib/mcp/tools-read'
import { searchAllProgram } from '#/lib/search/query'
import { createSpaceRow } from '#/lib/server/shared'
import { recordTimelineProgram } from '#/lib/timeline/record'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { emailDetailProgram } from './email-read'
import {
  setEmailAudienceProgram,
  setRecordEmailVisibilityProgram,
} from './email-privacy'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * D67's three layers at read time, against a real database: a synced
 * email's body and attachment are the mailbox owner's; the owner's override
 * on a record opens every email they have with it; a grant opens one email
 * to one member. Each reader a teammate has is asserted on its own.
 */

const HOUR = 3_600_000
const OWNER = FIXTURE_ACTOR
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@spaces.test',
  emailVerified: true,
}
const THIRD = {
  id: 'member-third',
  name: 'Sam',
  email: 'sam@spaces.test',
  emailVerified: true,
}
const BODY_TOKEN = 'flywheel'
const DECK_TOKEN = 'Quokka margins'
const shas = new Set<string>()
let gmail = ''

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values([TEAMMATE, THIRD])
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: OWNER.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: 'anish@fund.example',
        tokensEnc: Buffer.from('never read'),
        scopes: ['openid', 'email', 'gmail.readonly'],
        createdAt: new Date(Date.now() - HOUR),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!connection) throw new Error('no connection')
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'gmail',
        version: '0.1.0',
        enabled: true,
        connectionId: connection.id,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  gmail = row.id
})

afterEach(async () => {
  for (const sha of shas) await storage().delete(sha)
  shas.clear()
})

/** A synced email from Acme with a deck, its body naming `BODY_TOKEN`. */
async function syncEmail(subject: string) {
  const deck = `%PDF-1.4\nQuokkaplan ${randomUUID()}\n%%EOF\n`
  shas.add(createHash('sha256').update(deck).digest('hex'))
  const m: FakeGmailMessage = {
    id: `m-${randomUUID().slice(0, 8)}`,
    labelIds: ['INBOX'],
    receivedAt: Date.now() - 10 * 60_000,
    messageId: `${randomUUID()}@acme.io`,
    from: 'Jane Founder <jane@acme.io>',
    to: ['anish@fund.example'],
    cc: [],
    subject,
    body: `The ${BODY_TOKEN}-margin story is in the deck.`,
    attachments: [
      { filename: 'Quokkaplan.pdf', mime: 'application/pdf', content: deck },
    ],
  }
  const result = await Effect.runPromise(
    logSyncedEmailProgram(
      { integrationId: gmail },
      {
        providerMessageId: m.id,
        raw: Buffer.from(renderMessage(m)),
        receivedAt: new Date(m.receivedAt),
        labels: ['Inbox'],
      },
    ),
  )
  expect(result.outcome).toBe('created')
  const row = (
    await db
      .select({ id: interaction.id, noteId: interaction.noteId })
      .from(interaction)
      .where(eq(interaction.messageId, m.messageId ?? ''))
  ).at(0)
  if (!row || row.noteId === null) throw new Error('not synced')
  return { id: row.id, noteId: row.noteId }
}

/** One synced email on Acme, its deck read into a chunk, Acme in a space. */
async function fixture() {
  const email = await syncEmail('Acme — Q3 update')
  const acme = (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, 'domain'),
          eq(entityAlias.valueNorm, 'acme.io'),
        ),
      )
  ).at(0)?.id
  const deck = (
    await db
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.filename, 'Quokkaplan.pdf'))
  ).at(0)?.id
  if (acme === undefined || deck === undefined) throw new Error('no fixture')
  await db.insert(chunk).values({
    entityId: deck,
    sourceKind: 'document',
    idx: 0,
    text: `${DECK_TOKEN} are thin.`,
  })
  const space = await createSpaceRow('Robotics', null, OWNER.id)
  await db.insert(entitySpace).values({ entityId: acme, spaceId: space })
  return { email, acme, deck, space }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Viewer = { id: string }

/**
 * Each reader: whether `viewer` reaches the email's body or its attachment
 * there, never minding that its metadata is listed.
 */
const READERS: ReadonlyArray<{
  name: string
  reaches: (viewer: Viewer, f: Fixture) => Promise<boolean>
}> = [
  {
    name: 'the record timeline',
    reaches: async (viewer, f) => {
      const row = (
        await Effect.runPromise(recordTimelineProgram(f.acme, viewer))
      ).find((i) => i.id === f.email.id)
      // Subject, participants and date are listed either way.
      expect(row).toMatchObject({
        type: 'interaction',
        subject: 'Acme — Q3 update',
      })
      if (row?.type !== 'interaction') throw new Error('no row')
      const body = row.noteId === f.email.noteId && !row.privateBody
      const files = row.attachments === 1 && row.hasAttachments
      expect(files).toBe(body)
      return body
    },
  },
  {
    name: 'Cmd-K',
    reaches: async (viewer, f) => {
      const ids = async (q: string) =>
        (
          await Effect.runPromise(searchAllProgram({ userId: viewer.id, q }))
        ).map((h) => h.id)
      const body = (await ids(BODY_TOKEN)).includes(f.email.noteId)
      expect((await ids('Quokkaplan')).includes(f.deck)).toBe(body)
      return body
    },
  },
  {
    name: 'the context assembler',
    reaches: async (viewer, f) => {
      const text = JSON.stringify(
        await Effect.runPromise(
          assembleProgram(
            { entityId: f.acme },
            {
              user: viewer,
              asOf: new Date().toISOString(),
              budgetChars: 16_000,
              taskText: DECK_TOKEN,
            },
          ).pipe(Effect.provide(SimilarLaneLive)),
        ),
      )
      // The thread itself is there: metadata is shared.
      expect(text).toContain('Acme — Q3 update')
      return text.includes(DECK_TOKEN)
    },
  },
  {
    name: 'the MCP tools',
    reaches: async (viewer, f) => {
      const hits = await Effect.runPromise(
        searchRecordsProgram(viewer, { query: BODY_TOKEN }),
      )
      const body = hits.some((h) => h.id === f.email.noteId)
      const record = await Effect.runPromiseExit(
        getRecordProgram(viewer, f.email.noteId),
      )
      expect(record._tag === 'Success').toBe(body)
      const deck = await Effect.runPromiseExit(getRecordProgram(viewer, f.deck))
      expect(deck._tag === 'Success').toBe(body)
      return body
    },
  },
  {
    name: 'the email window',
    reaches: async (viewer, f) => {
      const email = await Effect.runPromise(
        emailDetailProgram(viewer, f.email.id, f.acme),
      )
      // Subject, participants, date and owner, always.
      expect(email).toMatchObject({
        subject: 'Acme — Q3 update',
        from: { email: 'jane@acme.io' },
        via: OWNER.name,
      })
      expect(email.occurredAt).toEqual(expect.any(String))
      const body = email.body.kind !== 'private'
      expect(email.attachments.map((a) => a.documentId)).toEqual(
        body ? [f.deck] : [],
      )
      return body
    },
  },
  {
    name: 'the file viewer’s details',
    reaches: async (viewer, f) =>
      (await Effect.runPromise(documentDetailsProgram(viewer, f.deck))) !==
      null,
  },
  {
    name: 'a space’s sources',
    reaches: async (viewer, f) =>
      (
        await Effect.runPromise(
          spaceInheritedSourcesProgram(f.space, viewer.id),
        )
      ).some((s) => s.id === f.deck),
  },
]

const grants = async () =>
  (await db.select({ n: count() }).from(emailGrant)).at(0)?.n ?? 0

describe('a synced email, reader by reader (D67)', () => {
  for (const reader of READERS)
    it(`is refused on ${reader.name} until its owner widens it`, async () => {
      const f = await fixture()
      expect(await reader.reaches(OWNER, f)).toBe(true)
      expect(await reader.reaches(TEAMMATE, f)).toBe(false)

      // Layer two: the owner's emails with Acme, open to the workspace.
      await Effect.runPromise(
        setRecordEmailVisibilityProgram(OWNER, {
          entityId: f.acme,
          workspace: true,
        }),
      )
      expect(await reader.reaches(TEAMMATE, f)).toBe(true)
      expect(await reader.reaches(THIRD, f)).toBe(true)
      await Effect.runPromise(
        setRecordEmailVisibilityProgram(OWNER, {
          entityId: f.acme,
          workspace: false,
        }),
      )
      expect(await reader.reaches(TEAMMATE, f)).toBe(false)

      // Layer three: this one email, to the teammate alone.
      await Effect.runPromise(
        setEmailAudienceProgram(OWNER, {
          interactionId: f.email.id,
          userIds: [TEAMMATE.id],
          record: null,
        }),
      )
      expect(await reader.reaches(TEAMMATE, f)).toBe(true)
      expect(await reader.reaches(THIRD, f)).toBe(false)
    })
})

describe('the two override tables', () => {
  it('open every email the owner has with the record, and closing it keeps the grants', async () => {
    const f = await fixture()
    const second = await syncEmail('Acme — board deck')
    await Effect.runPromise(
      setEmailAudienceProgram(OWNER, {
        interactionId: f.email.id,
        userIds: [THIRD.id],
        record: { id: f.acme, workspace: true },
      }),
    )
    const bodyOf = async (viewer: Viewer, id: string) =>
      (await Effect.runPromise(emailDetailProgram(viewer, id))).body.kind
    expect(await bodyOf(TEAMMATE, f.email.id)).not.toBe('private')
    expect(await bodyOf(TEAMMATE, second.id)).not.toBe('private')

    await Effect.runPromise(
      setRecordEmailVisibilityProgram(OWNER, {
        entityId: f.acme,
        workspace: false,
      }),
    )
    expect(await bodyOf(TEAMMATE, f.email.id)).toBe('private')
    expect(await bodyOf(TEAMMATE, second.id)).toBe('private')
    expect(await grants()).toBe(1)
    expect(await bodyOf(THIRD, f.email.id)).not.toBe('private')
  })

  it('grant one email to one member and nothing else', async () => {
    const f = await fixture()
    const sibling = await syncEmail('Acme — follow-up')
    await Effect.runPromise(
      setEmailAudienceProgram(OWNER, {
        interactionId: f.email.id,
        userIds: [TEAMMATE.id],
        record: null,
      }),
    )
    const view = (viewer: Viewer, id: string) =>
      Effect.runPromise(emailDetailProgram(viewer, id))
    const granted = await view(TEAMMATE, f.email.id)
    expect(granted.body.kind).not.toBe('private')
    expect(granted.attachments.map((a) => a.documentId)).toEqual([f.deck])
    expect(granted.privacy).toMatchObject({
      mine: false,
      workspace: false,
      grantees: [{ id: TEAMMATE.id, name: TEAMMATE.name, you: true }],
    })
    expect((await view(TEAMMATE, sibling.id)).body.kind).toBe('private')
    expect((await view(THIRD, f.email.id)).body.kind).toBe('private')

    // Unticked in the same dialog, the grant goes.
    await Effect.runPromise(
      setEmailAudienceProgram(OWNER, {
        interactionId: f.email.id,
        userIds: [],
        record: null,
      }),
    )
    expect((await view(TEAMMATE, f.email.id)).body.kind).toBe('private')
    expect(await grants()).toBe(0)
  })

  it('are written by the owner alone', async () => {
    const f = await fixture()
    const exit = await Effect.runPromiseExit(
      setEmailAudienceProgram(TEAMMATE, {
        interactionId: f.email.id,
        userIds: [TEAMMATE.id],
        record: { id: f.acme, workspace: true },
      }),
    )
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('EmailNotWidenable')
    expect(await grants()).toBe(0)
    // A teammate's override names their own mail, and so opens none of this.
    await Effect.runPromise(
      setRecordEmailVisibilityProgram(TEAMMATE, {
        entityId: f.acme,
        workspace: true,
      }),
    )
    expect(
      (await Effect.runPromise(emailDetailProgram(THIRD, f.email.id))).body
        .kind,
    ).toBe('private')
  })

  it('give the owner the privacy row for the record the window was opened from', async () => {
    const f = await fixture()
    const own = await Effect.runPromise(
      emailDetailProgram(OWNER, f.email.id, f.acme),
    )
    expect(own.privacy).toEqual({
      owner: { id: OWNER.id, name: OWNER.name },
      mine: true,
      workspace: false,
      grantees: [],
      record: { id: f.acme, name: expect.any(String), on: false },
    })
    await Effect.runPromise(
      setRecordEmailVisibilityProgram(OWNER, {
        entityId: f.acme,
        workspace: true,
      }),
    )
    expect(
      (await Effect.runPromise(emailDetailProgram(OWNER, f.email.id, f.acme)))
        .privacy,
    ).toMatchObject({ workspace: true, record: { on: true } })
  })
})
