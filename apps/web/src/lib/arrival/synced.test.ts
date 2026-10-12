import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, count, eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionEntity,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { activity } from '@spaces/db/schema/activity'
import { FAKE_GMAIL_DECK, renderMessage } from '@spaces/sdk/testing'
import type { FakeGmailMessage } from '@spaces/sdk/testing'
import { assembleProgram } from '@spaces/core/writes/context/assemble'
import { getRecordProgram } from '@spaces/core/writes/read/record'
import { truncateAndReseed } from '#/test/reseed'
import { SimilarLaneLive } from '#/lib/ai/similar'
import { searchRecordsProgram } from '#/lib/mcp/tools-read'
import { searchAllProgram } from '#/lib/search/query'
import { recordTimelineProgram } from '#/lib/timeline/record'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { fileArrivalProgram } from './file'
import { saveMailboxSyncProgram } from './mailbox-sync'
import { arrivalFromSource } from './message'
import { logSyncedEmailProgram } from './synced'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The synced mailbox's lane against a real database, and D67 at read time:
 * the owner's synced body is stored whole and private, and every read path a
 * teammate has — the record timeline, Cmd-K, the context assembler and the
 * AI substrate's MCP tools — refuses it, each asserted on its own.
 */

const HOUR = 3_600_000
const OWNER_ADDRESS = 'anish@fund.example'
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@spaces.test',
  emailVerified: true,
}

const message = (over: Partial<FakeGmailMessage> = {}): FakeGmailMessage => ({
  id: `m-${randomUUID().slice(0, 8)}`,
  labelIds: ['INBOX'],
  receivedAt: Date.now() - 10 * 60_000,
  messageId: `${randomUUID()}@acme-robotics.example`,
  from: 'Jane Founder <jane@acme-robotics.example>',
  to: [OWNER_ADDRESS],
  cc: ['Acme CFO <cfo@acme-robotics.example>'],
  subject: 'Acme Robotics — Q3 update',
  body: 'Q3 closed ahead of plan. The flywheel-margin story is in the deck.',
  ...over,
})

let mailbox = { integrationId: '', connectionId: '' }

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values(TEAMMATE)
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: OWNER_ADDRESS,
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
  mailbox = { integrationId: row.id, connectionId: connection.id }
})

const sync = (m: FakeGmailMessage, labels: ReadonlyArray<string> = ['Inbox']) =>
  Effect.runPromise(
    logSyncedEmailProgram(
      { integrationId: mailbox.integrationId },
      {
        providerMessageId: m.id,
        raw: Buffer.from(renderMessage(m)),
        receivedAt: new Date(m.receivedAt),
        labels,
      },
    ),
  )

const save = (over: {
  shareBodies?: boolean
  excludeSenders?: Array<string>
  excludeLabels?: Array<string>
}) =>
  Effect.runPromise(
    saveMailboxSyncProgram(FIXTURE_ACTOR.id, {
      connectionId: mailbox.connectionId,
      shareBodies: over.shareBodies ?? false,
      excludeSenders: over.excludeSenders ?? ['noreply@'],
      excludeLabels: over.excludeLabels ?? ['Promotions'],
    }),
  )

const rowOf = async (messageId: string) =>
  (
    await db
      .select()
      .from(interaction)
      .where(eq(interaction.messageId, messageId))
  ).at(0) ?? null

const notes = async () =>
  (await db.select({ n: count() }).from(note)).at(0)?.n ?? 0

const companyOf = async (domain: string) =>
  (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(eq(entityAlias.kind, 'domain'), eq(entityAlias.valueNorm, domain)),
      )
  ).at(0)?.id ?? null

describe('a synced message', () => {
  it('lands on its participants with its headers, its deck and a body private to the mailbox owner (D67)', async () => {
    const m = message({
      attachments: [
        {
          filename: 'acme-q3.pdf',
          mime: 'application/pdf',
          content: FAKE_GMAIL_DECK,
        },
      ],
    })
    const result = await sync(m, ['Inbox', 'Primary'])
    expect(result.outcome).toBe('created')
    const row = await rowOf(m.messageId ?? '')
    expect(row).toMatchObject({
      kind: 'email',
      sourceClass: 'integration',
      sourceRef: mailbox.integrationId,
      subject: 'Acme Robotics — Q3 update',
      meta: {
        kind: 'email',
        from: 'jane@acme-robotics.example',
        to: [],
        cc: ['cfo@acme-robotics.example'],
        mime_blob_sha: null,
        labels: ['Inbox', 'Primary'],
      },
    })
    const body = (
      await db
        .select()
        .from(note)
        .where(eq(note.entityId, row?.noteId ?? ''))
    ).at(0)
    expect(body).toMatchObject({
      visibility: 'private',
      authorId: FIXTURE_ACTOR.id,
    })
    expect(body?.bodyMd).toContain('flywheel-margin')

    const acme = await companyOf('acme-robotics.example')
    expect(acme).not.toBeNull()
    const edged = await db
      .select({ id: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, row?.id ?? ''))
    expect(edged.map((e) => e.id)).toContain(acme)
    const deck = await db
      .select({ filename: document.filename, sourceRef: document.sourceRef })
      .from(document)
      .where(eq(document.filename, 'acme-q3.pdf'))
    expect(deck).toEqual([
      { filename: 'acme-q3.pdf', sourceRef: mailbox.integrationId },
    ])
  })

  it('is refused when it was received before the mailbox was connected', async () => {
    const m = message({ receivedAt: Date.now() - 30 * 24 * HOUR })
    expect(await sync(m)).toEqual({
      outcome: 'refused',
      reason: 'received before the mailbox was connected',
    })
    expect(await rowOf(m.messageId ?? '')).toBeNull()
  })

  it('is refused when it cannot be parsed, rather than retried', async () => {
    const result = await Effect.runPromise(
      logSyncedEmailProgram(
        { integrationId: mailbox.integrationId },
        {
          providerMessageId: 'm-broken',
          raw: new Uint8Array([0xff, 0xfe, 0x00]),
          receivedAt: new Date(),
          labels: [],
        },
      ),
    )
    expect(result.outcome).toBe('refused')
  })

  it('refuses noise and the default blocklist before anything is stored', async () => {
    const before = await notes()
    expect((await sync(message(), ['Inbox', 'Promotions'])).outcome).toBe(
      'refused',
    )
    expect(
      (await sync(message({ from: 'SaaS <noreply@saas.example>' }))).outcome,
    ).toBe('refused')
    expect(
      (
        await sync(
          message({
            headers: { 'List-Unsubscribe': '<mailto:leave@list.example>' },
          }),
        )
      ).outcome,
    ).toBe('refused')
    expect(await notes()).toBe(before)
    expect((await db.select({ n: count() }).from(interaction)).at(0)?.n).toBe(0)
  })
})

describe('the forwarding mailbox and the synced one', () => {
  const forward = async (messageId: string) => {
    const core = (
      await db
        .insert(integration)
        .values({ capabilityId: 'core.mailbox', version: '1', enabled: true })
        .returning({ id: integration.id })
    ).at(0)
    if (!core) throw new Error('no core mailbox')
    const arrival = await arrivalFromSource(
      [
        'From: Jane Founder <jane@acme-robotics.example>',
        `To: ${OWNER_ADDRESS}`,
        'Subject: Acme Robotics — Q3 update',
        'Date: Mon, 21 Sep 2026 10:04:00 +0000',
        `Message-ID: <${messageId}>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        'Forwarded in.',
        '',
      ].join('\r\n'),
      { mailboxAddress: 'deals@fund.example', receivedAt: new Date() },
    )
    if (arrival.kind !== 'message') throw new Error('refused')
    return Effect.runPromise(
      fileArrivalProgram(arrival.message, {
        integrationId: core.id,
        authorId: FIXTURE_ACTOR.id,
      }),
    )
  }

  it('write one interaction for one Message-ID, whichever lane is first', async () => {
    const forwardedFirst = message()
    expect((await forward(forwardedFirst.messageId ?? '')).kind).toBe('written')
    expect(await sync(forwardedFirst)).toEqual({ outcome: 'duplicate' })

    const syncedFirst = message()
    expect((await sync(syncedFirst)).outcome).toBe('created')
    const held = await rowOf(syncedFirst.messageId ?? '')
    const visibility = async () =>
      (
        await db
          .select({ v: note.visibility })
          .from(note)
          .where(eq(note.entityId, held?.noteId ?? ''))
      ).at(0)?.v
    expect(await visibility()).toBe('private')
    // Forwarding is the consent (D49): the synced body widens, logged.
    expect((await forward(syncedFirst.messageId ?? '')).kind).toBe('duplicate')
    expect(await visibility()).toBe('shared')
    expect(
      await db
        .select({ verb: activity.verb, meta: activity.meta })
        .from(activity)
        .where(eq(activity.subjectEntityId, held?.noteId ?? '')),
    ).toEqual([
      {
        verb: 'note.visibility_changed',
        meta: expect.objectContaining({ from: 'private', to: 'shared' }),
      },
    ])
    // A synced duplicate of a forwarded thread changes nothing.
    const forwardedRow = await rowOf(forwardedFirst.messageId ?? '')
    expect(
      (
        await db
          .select({ v: note.visibility })
          .from(note)
          .where(eq(note.entityId, forwardedRow?.noteId ?? ''))
      ).at(0)?.v,
    ).toBe('shared')

    const rows = await db
      .select({ id: interaction.id })
      .from(interaction)
      .where(
        inArray(interaction.messageId, [
          forwardedFirst.messageId ?? '',
          syncedFirst.messageId ?? '',
        ]),
      )
    expect(rows).toHaveLength(2)
  })
})

describe('the account page’s settings', () => {
  it('removes mail a newly excluded domain already synced, body and all', async () => {
    const kept = message({
      from: 'Lee Gamma <lee@gamma.example>',
      cc: [],
      messageId: `${randomUUID()}@gamma.example`,
    })
    const dropped = message()
    await sync(kept)
    await sync(dropped)
    const droppedRow = await rowOf(dropped.messageId ?? '')
    const result = await save({
      excludeSenders: ['noreply@', 'acme-robotics.example'],
    })
    expect(result.removed).toBe(1)
    expect(await rowOf(dropped.messageId ?? '')).toBeNull()
    expect(await rowOf(kept.messageId ?? '')).not.toBeNull()
    expect(
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(eq(entity.id, droppedRow?.noteId ?? '')),
    ).toEqual([])
    // And new mail from it is refused before a body is stored.
    expect((await sync(message())).outcome).toBe('refused')
  })

  it('moves every body with the sharing toggle, both ways', async () => {
    const m = message()
    await sync(m)
    const row = await rowOf(m.messageId ?? '')
    const visibility = async () =>
      (
        await db
          .select({ v: note.visibility })
          .from(note)
          .where(eq(note.entityId, row?.noteId ?? ''))
      ).at(0)?.v
    expect((await save({ shareBodies: true })).revisited).toBe(1)
    expect(await visibility()).toBe('shared')
    const after = message()
    await sync(after)
    const shared = await rowOf(after.messageId ?? '')
    expect(
      (
        await db
          .select({ v: note.visibility })
          .from(note)
          .where(eq(note.entityId, shared?.noteId ?? ''))
      ).at(0)?.v,
    ).toBe('shared')
    await save({ shareBodies: false })
    expect(await visibility()).toBe('private')
  })

  it('belongs to the connection’s owner alone', async () => {
    const exit = await Effect.runPromiseExit(
      saveMailboxSyncProgram(TEAMMATE.id, {
        connectionId: mailbox.connectionId,
        shareBodies: true,
        excludeSenders: [],
        excludeLabels: [],
      }),
    )
    expect(exit._tag).toBe('Failure')
  })
})

/**
 * D67 at read time: the body is stored whole; who reads it is decided on
 * the way out. One test per path a teammate has, each with the owner as its
 * control where the path reaches the body at all.
 */
describe('a synced body private to its owner', () => {
  const TOKEN = 'flywheel'
  const synced = async () => {
    const m = message()
    await sync(m)
    const row = await rowOf(m.messageId ?? '')
    const acme = await companyOf('acme-robotics.example')
    if (row === null || row.noteId === null || acme === null)
      throw new Error('not synced')
    return { noteId: row.noteId, interactionId: row.id, acme }
  }

  it('is not reachable from the record timeline', async () => {
    const { noteId, interactionId, acme } = await synced()
    const theirs = await Effect.runPromise(
      recordTimelineProgram(acme, TEAMMATE),
    )
    const row = theirs.find((i) => i.id === interactionId)
    // Subject, people and date stay; the body is neither linked nor offered.
    expect(row).toMatchObject({
      type: 'interaction',
      subject: 'Acme Robotics — Q3 update',
      noteId: null,
      privateBody: true,
    })
    expect(JSON.stringify(theirs)).not.toContain(noteId)
    const mine = await Effect.runPromise(
      recordTimelineProgram(acme, FIXTURE_ACTOR),
    )
    expect(mine.find((i) => i.id === interactionId)).toMatchObject({
      noteId,
      privateBody: false,
    })
  })

  it('is not reachable from Cmd-K', async () => {
    const { noteId } = await synced()
    const theirs = await Effect.runPromise(
      searchAllProgram({ userId: TEAMMATE.id, q: TOKEN }),
    )
    expect(theirs.map((h) => h.id)).not.toContain(noteId)
    expect(JSON.stringify(theirs)).not.toContain(TOKEN)
    const mine = await Effect.runPromise(
      searchAllProgram({ userId: FIXTURE_ACTOR.id, q: TOKEN }),
    )
    expect(mine.map((h) => h.id)).toContain(noteId)
  })

  it('is not reachable from the context assembler', async () => {
    const { acme } = await synced()
    const assembled = await Effect.runPromise(
      assembleProgram(
        { entityId: acme },
        {
          user: { id: TEAMMATE.id },
          asOf: new Date().toISOString(),
          budgetChars: 16_000,
          taskText: TOKEN,
        },
      ).pipe(Effect.provide(SimilarLaneLive)),
    )
    expect(JSON.stringify(assembled)).not.toContain('flywheel-margin')
    // The thread itself is there: metadata is shared.
    expect(JSON.stringify(assembled)).toContain('Acme Robotics — Q3 update')
  })

  it('is not reachable from the AI substrate’s tools', async () => {
    const { noteId } = await synced()
    const hits = await Effect.runPromise(
      searchRecordsProgram(TEAMMATE, { query: TOKEN }),
    )
    expect(hits.map((h) => h.id)).not.toContain(noteId)
    const record = await Effect.runPromiseExit(
      getRecordProgram(TEAMMATE, noteId),
    )
    expect(record._tag).toBe('Failure')
    expect(JSON.stringify(record)).not.toContain('flywheel-margin')
    const own = await Effect.runPromiseExit(
      getRecordProgram(FIXTURE_ACTOR, noteId),
    )
    expect(own._tag).toBe('Success')
  })
})
