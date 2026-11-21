import { createHash, randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { simpleParser } from 'mailparser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  company,
  document,
  entity,
  entityAlias,
  integration,
  interaction,
  link,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { renderMessage } from '@spaces/sdk/testing'
import type { FakeGmailMessage } from '@spaces/sdk/testing'
import { QUEUES } from '@spaces/core/queue/names'
import { forgetConnection } from '@spaces/core/writes/connections/list'
import { markNewerVersionProgram } from '@spaces/core/writes/links/supersedes'
import { storage } from '@spaces/core/writes/storage'
import { recordDocumentRows } from '#/lib/documents/record-files'
import { documentBytesProgram } from '#/lib/documents/remote-bytes'
import { fileByHandProgram, keepCopyProgram } from '#/lib/documents/keep-copy'
import { recordTabCounts } from '#/lib/records/record-tabs'
import { enqueued } from '#/test/queue-stub'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  AttachmentUnavailable,
  MailAttachments,
  attachmentIn,
  mailAttachmentOf,
} from './mail-attachments'
import { attachmentExternalId } from './attachment-pointer'
import { logSyncedEmailProgram } from './synced'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * A synced attachment keeps its text, and its file stays in Gmail
 * until a person keeps it. Gmail cannot be reached from a test, so the
 * mailbox is a stub `MailAttachments` answering the bytes each message was
 * rendered with; the part matching (`attachmentIn`) runs for real.
 */

const HOUR = 3_600_000
const OWNER_ADDRESS = 'anish@fund.example'
let gmail = ''
let connectionId = ''
/** What the stub mailbox holds, by Gmail message id. */
const mailbox = new Map<string, Buffer>()
const shas = new Set<string>()

const stubMailbox = Layer.succeed(
  MailAttachments,
  MailAttachments.of({
    fetch: ({ pointer }) => {
      const raw = mailbox.get(pointer.messageId)
      return raw === undefined
        ? Effect.fail(
            new AttachmentUnavailable({
              reason: 'The email is no longer in Gmail',
              retryable: false,
            }),
          )
        : attachmentIn(raw, pointer.sha)
    },
  }),
)

beforeEach(async () => {
  await truncateAndReseed()
  enqueued.length = 0
  mailbox.clear()
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
  connectionId = connection.id
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'gmail',
        version: '0.1.0',
        enabled: true,
        connectionId,
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

const digest = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex')

/** A deck unique to this test, its digest remembered for cleanup. */
function pdf(phrase: string): string {
  const text = `%PDF-1.4\n${phrase} ${randomUUID()}\n%%EOF\n`
  shas.add(digest(text))
  return text
}

const message = (over: Partial<FakeGmailMessage>): FakeGmailMessage => ({
  id: `m${randomUUID().replaceAll('-', '').slice(0, 15)}`,
  labelIds: ['INBOX'],
  receivedAt: Date.now() - 10 * 60_000,
  messageId: `${randomUUID()}@acme.io`,
  from: 'Jane Founder <jane@acme.io>',
  to: [OWNER_ADDRESS],
  cc: [],
  subject: 'Q3 update',
  body: 'The deck is attached.',
  ...over,
})

/** The message synced, as the Gmail plugin hands it to `Content.logEmail`. */
async function sync(m: FakeGmailMessage) {
  const raw = Buffer.from(renderMessage(m))
  mailbox.set(m.id, raw)
  return Effect.runPromise(
    logSyncedEmailProgram(
      { integrationId: gmail },
      {
        providerMessageId: m.id,
        raw,
        receivedAt: new Date(m.receivedAt),
        labels: ['Inbox'],
      },
    ),
  )
}

async function acme(): Promise<string> {
  const row = (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, 'domain'),
          eq(entityAlias.valueNorm, 'acme.io'),
        ),
      )
  ).at(0)
  if (!row) throw new Error('no acme')
  return row.id
}

const docs = () =>
  db
    .select({
      id: document.entityId,
      filename: document.filename,
      blobSha: document.blobSha,
      connectionId: document.connectionId,
      externalId: document.externalId,
      externalStatus: document.externalStatus,
      sizeBytes: document.sizeBytes,
    })
    .from(document)

/** A deck and a signature logo, synced; the deck's row and digest. */
async function deckAndLogo() {
  const deck = pdf('Atmos investor deck')
  const m = message({
    attachments: [
      { filename: 'Atmos deck.pdf', mime: 'application/pdf', content: deck },
      {
        filename: 'image001.png',
        mime: 'image/png',
        content: 'P'.repeat(3_000),
      },
    ],
  })
  expect((await sync(m)).outcome).toBe('created')
  const rows = await docs()
  const row = rows.at(0)
  if (row === undefined) throw new Error('no document')
  return { m, deck, sha: digest(deck), row, rows }
}

const keep = (documentId: string) =>
  Effect.runPromise(
    keepCopyProgram(FIXTURE_ACTOR.id, documentId).pipe(
      Effect.provide(stubMailbox),
    ),
  )

describe('a synced email with a PDF and a signature logo', () => {
  it('is one document with no bytes, its pointer, and its text queued; the raw MIME keeps no attachment body', async () => {
    const { m, sha, row, rows } = await deckAndLogo()
    expect(rows).toHaveLength(1)
    expect(row).toMatchObject({
      filename: 'Atmos deck.pdf',
      blobSha: null,
      connectionId,
      externalId: attachmentExternalId(m.id, sha),
      externalStatus: 'linked',
    })
    expect(await storage().exists(sha)).toBe(false)
    // Extraction is sent, and fetches through the connection.
    expect(enqueued.filter((e) => e.name === QUEUES.extractDocument)).toEqual([
      { name: QUEUES.extractDocument, data: { documentId: row.id } },
    ])

    const email = (
      await db
        .select({ meta: interaction.meta })
        .from(interaction)
        .where(eq(interaction.messageId, m.messageId ?? ''))
    ).at(0)
    const mimeSha =
      email?.meta?.kind === 'email' ? email.meta.mime_blob_sha : null
    if (mimeSha === null) throw new Error('no MIME')
    shas.add(mimeSha)
    const stored = await simpleParser(
      Buffer.from(await storage().getBytes(mimeSha)),
    )
    expect(stored.text).toContain('The deck is attached.')
    expect(stored.attachments.map((a) => a.content.length)).toEqual([0, 0])
  })

  it('answers the mailbox pointer for the viewer, and its bytes once a fetch has cached them', async () => {
    const { deck, sha, row } = await deckAndLogo()
    expect(await Effect.runPromise(mailAttachmentOf(row.id))).toMatchObject({
      _tag: 'target',
      connectionId,
      pointer: { sha },
    })
    const open = await Effect.runPromise(
      documentBytesProgram(FIXTURE_ACTOR.id, row.id, { poll: false }),
    )
    expect(open).toEqual({ state: 'fetching', from: 'Gmail' })
    expect(enqueued.filter((e) => e.name === QUEUES.fetchRemoteBytes)).toEqual([
      {
        name: QUEUES.fetchRemoteBytes,
        data: { documentId: row.id },
        options: { singletonKey: row.id },
      },
    ])
    // What the worker's fetch leaves: the bytes under their digest.
    await storage().put(sha, Buffer.from(deck), { mime: 'application/pdf' })
    const again = await Effect.runPromise(
      documentBytesProgram(FIXTURE_ACTOR.id, row.id, { poll: true }),
    )
    expect(again.state).toBe('ready')
    // The row still holds no bytes: a viewer's fetch is a cache.
    expect((await docs()).at(0)?.blobSha).toBeNull()
  })
})

describe('the file is kept', () => {
  it('by Keep a copy: fetched from the mailbox, stored, named by blob_sha', async () => {
    const { deck, sha, row } = await deckAndLogo()
    expect(await keep(row.id)).toEqual({ _tag: 'kept' })
    expect((await docs()).at(0)).toMatchObject({
      blobSha: sha,
      sizeBytes: Buffer.byteLength(deck),
    })
    expect(Buffer.from(await storage().getBytes(sha)).toString()).toBe(deck)
    const kept = await db
      .select({ actorId: activity.actorId })
      .from(activity)
      .where(eq(activity.verb, 'document.kept'))
    expect(kept).toEqual([{ actorId: FIXTURE_ACTOR.id }])
    // Twice is the same file.
    expect(await keep(row.id)).toEqual({ _tag: 'held' })
  })

  it('by File on…: the hand edge, then the copy', async () => {
    const { sha, row } = await deckAndLogo()
    // A record the email never touched: the filing is the person's alone.
    const other = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: 'Atmos Ventures' })
        .returning({ id: entity.id })
    ).at(0)
    if (!other) throw new Error('no company')
    await db.insert(company).values({ entityId: other.id })
    const outcome = await Effect.runPromise(
      fileByHandProgram(FIXTURE_ACTOR.id, {
        documentId: row.id,
        target: { kind: 'record', entityId: other.id },
      }).pipe(Effect.provide(stubMailbox)),
    )
    expect(outcome).toEqual({ filed: true })
    expect((await docs()).at(0)?.blobSha).toBe(sha)
  })

  it('not by the automatic filing, nor by accepting a newer version', async () => {
    const first = await deckAndLogo()
    const later = message({
      subject: 'Q3 update v2',
      attachments: [
        {
          filename: 'Atmos deck v2.pdf',
          mime: 'application/pdf',
          content: pdf('Atmos investor deck v2'),
        },
      ],
    })
    await sync(later)
    const newer = (await docs()).find((d) => d.filename === 'Atmos deck v2.pdf')
    if (newer === undefined) throw new Error('no newer deck')
    await Effect.runPromise(
      markNewerVersionProgram({
        newerId: newer.id,
        olderId: first.row.id,
        actorId: FIXTURE_ACTOR.id,
      }),
    )
    for (const d of await docs()) expect(d.blobSha).toBeNull()
  })
})

describe('a disconnected mailbox', () => {
  it('turns its attachment rows gone, keeps their text, and refuses a fetch or a copy', async () => {
    const { row } = await deckAndLogo()
    await db
      .update(document)
      .set({ extractedText: 'Atmos investor deck', extractionStatus: 'done' })
      .where(eq(document.entityId, row.id))

    expect(await forgetConnection(FIXTURE_ACTOR.id, connectionId)).toBe(true)
    const after = await db
      .select({
        externalStatus: document.externalStatus,
        extractedText: document.extractedText,
      })
      .from(document)
      .where(eq(document.entityId, row.id))
    expect(after).toEqual([
      { externalStatus: 'gone', extractedText: 'Atmos investor deck' },
    ])

    expect(
      await Effect.runPromise(
        documentBytesProgram(FIXTURE_ACTOR.id, row.id, { poll: false }),
      ),
    ).toEqual({
      state: 'unavailable',
      reason: 'Gmail was disconnected; only this file’s text is kept here',
    })
    await expect(keep(row.id)).rejects.toMatchObject({
      message: 'Gmail was disconnected; only this file’s text is kept here',
    })
    const listed = await recordDocumentRows(FIXTURE_ACTOR.id, await acme())
    expect(listed.map((d) => d.remoteBytes)).toEqual(['gone'])
  })
})

describe('the Files tab', () => {
  it('puts attachments nobody filed by hand in the From email band, outside the tab’s count, until one is kept', async () => {
    const { row } = await deckAndLogo()
    const acmeId = await acme()
    const listed = await recordDocumentRows(FIXTURE_ACTOR.id, acmeId)
    expect(
      listed.map((d) => ({
        id: d.id,
        fromEmail: d.fromEmail,
        remoteBytes: d.remoteBytes,
        followable: d.followable,
      })),
    ).toEqual([
      { id: row.id, fromEmail: true, remoteBytes: 'linked', followable: false },
    ])
    const counts = (documents: ReadonlyArray<{ fromEmail: boolean }>) =>
      recordTabCounts({
        notes: { filed: [], fromMeetings: [], mentions: [] },
        timeline: [],
        documents,
      }).files
    expect(counts(listed)).toBe(0)

    // An edge a person made, or the copy they kept, moves it out.
    await db
      .update(link)
      .set({ createdBy: FIXTURE_ACTOR.id })
      .where(and(eq(link.fromEntityId, row.id), eq(link.toEntityId, acmeId)))
    const handFiled = await recordDocumentRows(FIXTURE_ACTOR.id, acmeId)
    expect(handFiled.map((d) => d.fromEmail)).toEqual([false])
    expect(counts(handFiled)).toBe(1)
  })
})
