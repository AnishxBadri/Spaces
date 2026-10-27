import { createHash, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  integration,
  interaction,
  pendingBlob,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { storage } from '@spaces/core/writes/storage'
import { truncateAndReseed } from '#/test/reseed'
import { blobIsReferenced } from '#/lib/documents/blob-refs'
import { fileArrivalProgram } from '#/lib/arrival/file'
import { arrivalFromSource } from '#/lib/arrival/message'
import { saveMailboxSyncProgram } from '#/lib/arrival/mailbox-sync'
import { logSyncedEmailProgram } from '#/lib/arrival/synced'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { TRACKER, htmlEmail } from '#/lib/email/fixtures'
import { emailDetailProgram } from './email-read'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The stored MIME and the window over it: both lanes keep the raw
 * bytes as one content-addressed blob, and the window reads the body only
 * through the gate the timeline uses.
 */

const HOUR = 3_600_000
const OWNER = 'anish@fund.example'
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@fund.example',
  emailVerified: true,
}

const mailboxOf = async (userId: string, address: string) => {
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'google',
        product: 'gmail',
        externalEmail: address,
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
  return { integrationId: row.id, connectionId: connection.id }
}

let mine = ''
let mineConnection = ''
let theirs = ''

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values(TEAMMATE)
  const own = await mailboxOf(FIXTURE_ACTOR.id, OWNER)
  mine = own.integrationId
  mineConnection = own.connectionId
  theirs = (await mailboxOf(TEAMMATE.id, TEAMMATE.email)).integrationId
})

const sync = (integrationId: string, raw: string) =>
  Effect.runPromise(
    logSyncedEmailProgram(
      { integrationId },
      {
        providerMessageId: `m-${randomUUID().slice(0, 8)}`,
        raw: Buffer.from(raw),
        receivedAt: new Date(Date.now() - 5 * 60_000),
        labels: ['Inbox'],
      },
    ),
  )

const rowOf = async (messageId: string) =>
  (
    await db
      .select()
      .from(interaction)
      .where(eq(interaction.messageId, messageId))
  ).at(0) ?? null

const sha256 = (raw: string) =>
  createHash('sha256').update(Buffer.from(raw)).digest('hex')

const shaOf = (meta: unknown) =>
  typeof meta === 'object' && meta !== null && 'mime_blob_sha' in meta
    ? meta.mime_blob_sha
    : null

describe('the stored MIME', () => {
  it('is one blob keyed by its sha, shared when two mailboxes hold the message', async () => {
    const messageId = `${randomUUID()}@acme-robotics.example`
    const raw = htmlEmail({ messageId, to: `${OWNER}, ${TEAMMATE.email}` })
    expect((await sync(mine, raw)).outcome).toBe('created')
    expect(await sync(theirs, raw)).toEqual({ outcome: 'duplicate' })

    const rows = await db
      .select()
      .from(interaction)
      .where(eq(interaction.messageId, messageId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.meta).toMatchObject({
      kind: 'email',
      from: 'jane@acme-robotics.example',
      to: [TEAMMATE.email],
      cc: ['cfo@acme-robotics.example'],
      mime_blob_sha: sha256(raw),
    })
    expect(await storage().exists(sha256(raw))).toBe(true)
    expect(Buffer.from(await storage().getBytes(sha256(raw))).toString()).toBe(
      raw,
    )
    // Named by the row, so neither GC direction may take it.
    expect(await blobIsReferenced(sha256(raw))).toBe(true)
    expect(await db.select().from(pendingBlob)).toHaveLength(0)
  })

  it('is not stored for a second mailbox whose copy differs by its own headers', async () => {
    const messageId = `${randomUUID()}@acme-robotics.example`
    const raw = htmlEmail({ messageId, to: `${OWNER}, ${TEAMMATE.email}` })
    const theirCopy = `Received: from mx.fund.example by priya\r\n${raw}`
    expect((await sync(mine, raw)).outcome).toBe('created')
    expect(await sync(theirs, theirCopy)).toEqual({ outcome: 'duplicate' })
    expect(await storage().exists(sha256(theirCopy))).toBe(false)
    expect(await db.select().from(pendingBlob)).toHaveLength(0)
    expect(shaOf((await rowOf(messageId))?.meta)).toBe(sha256(raw))
  })

  it('goes with its row when the exclude list removes the email', async () => {
    const messageId = `${randomUUID()}@acme-robotics.example`
    const raw = htmlEmail({ messageId, to: OWNER })
    expect((await sync(mine, raw)).outcome).toBe('created')
    expect(await storage().exists(sha256(raw))).toBe(true)
    const saved = await Effect.runPromise(
      saveMailboxSyncProgram(FIXTURE_ACTOR.id, {
        connectionId: mineConnection,
        shareBodies: false,
        excludeSenders: ['acme-robotics.example'],
        excludeLabels: [],
      }),
    )
    expect(saved.removed).toBe(1)
    expect(await rowOf(messageId)).toBeNull()
    expect(await storage().exists(sha256(raw))).toBe(false)
  })

  it('is written by the forwarding lane too', async () => {
    const core = (
      await db
        .insert(integration)
        .values({ capabilityId: 'core.mailbox', version: '1', enabled: true })
        .returning({ id: integration.id })
    ).at(0)
    if (!core) throw new Error('no core mailbox')
    const messageId = `${randomUUID()}@acme-robotics.example`
    const raw = htmlEmail({ messageId, to: 'deals@fund.example' })
    const arrival = await arrivalFromSource(raw, {
      mailboxAddress: 'deals@fund.example',
      receivedAt: new Date(),
    })
    if (arrival.kind !== 'message') throw new Error('refused')
    const filed = await Effect.runPromise(
      fileArrivalProgram(arrival.message, {
        integrationId: core.id,
        authorId: FIXTURE_ACTOR.id,
      }),
    )
    expect(filed.kind).toBe('written')
    expect(shaOf((await rowOf(messageId))?.meta)).toBe(sha256(raw))
    expect(await storage().exists(sha256(raw))).toBe(true)
  })
})

describe('the email window', () => {
  const synced = async () => {
    const messageId = `${randomUUID()}@acme-robotics.example`
    expect(
      (await sync(mine, htmlEmail({ messageId, to: OWNER }))).outcome,
    ).toBe('created')
    const row = await rowOf(messageId)
    if (row === null) throw new Error('not synced')
    return row.id
  }

  it('shows the owner the sanitized HTML, the pixel never loading', async () => {
    const id = await synced()
    const email = await Effect.runPromise(emailDetailProgram(FIXTURE_ACTOR, id))
    expect(email).toMatchObject({
      subject: 'Acme Robotics — Q3 update',
      from: { email: 'jane@acme-robotics.example', name: 'Jane Founder' },
      cc: [{ email: 'cfo@acme-robotics.example' }],
      via: FIXTURE_ACTOR.name,
      body: { kind: 'html', remoteImages: 2 },
    })
    if (email.body.kind !== 'html') throw new Error('no html')
    expect(email.body.srcdoc).toContain('Q3 closed ahead of plan.')
    expect(email.body.srcdoc).not.toContain(TRACKER)
    expect(email.body.srcdoc).not.toMatch(/<script/i)
  })

  it('shows a teammate the headers and a private body, never the HTML (D67)', async () => {
    const id = await synced()
    const email = await Effect.runPromise(emailDetailProgram(TEAMMATE, id))
    expect(email).toMatchObject({
      subject: 'Acme Robotics — Q3 update',
      from: { email: 'jane@acme-robotics.example' },
      body: { kind: 'private' },
      attachments: [],
    })
    expect(JSON.stringify(email)).not.toContain('Q3 closed')
  })

  it('lists the earlier messages of its thread, each preview read through canRead', async () => {
    const at = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * 60_000).toUTCString()
    const sent = async (integrationId: string, minutesAgo: number) => {
      const messageId = `${randomUUID()}@acme-robotics.example`
      const raw = htmlEmail({ messageId, to: OWNER, date: at(minutesAgo) })
      expect((await sync(integrationId, raw)).outcome).toBe('created')
      const row = await rowOf(messageId)
      if (row === null) throw new Error('not synced')
      await db
        .update(interaction)
        .set({ threadId: 'thread-acme', occurredAt: new Date(at(minutesAgo)) })
        .where(eq(interaction.id, row.id))
      return row.id
    }
    // Oldest in Priya's mailbox (private to her), then one in mine, then the
    // message the window opens on.
    const theirsId = await sent(theirs, 90)
    const mineId = await sent(mine, 60)
    const opened = await sent(mine, 30)

    const email = await Effect.runPromise(
      emailDetailProgram(FIXTURE_ACTOR, opened),
    )
    expect(email.thread.messages).toBe(3)
    expect(email.thread.earlier.map((l) => l.id)).toEqual([theirsId, mineId])
    const [private_, readable] = email.thread.earlier
    // Headers stay visible to all; the body's preview does not.
    expect(private_).toMatchObject({
      who: 'Jane Founder',
      sent: false,
      preview: null,
      attachments: 0,
    })
    expect(readable.preview).toContain('Q3 closed ahead of plan.')
    expect(JSON.stringify(private_)).not.toContain('Q3 closed')

    // Opened on the earliest, there is nothing earlier and the count stays.
    const first = await Effect.runPromise(
      emailDetailProgram(FIXTURE_ACTOR, theirsId),
    )
    expect(first.thread).toEqual({ messages: 3, earlier: [] })
  })

  it('refuses an id that is not an email', async () => {
    const exit = await Effect.runPromiseExit(
      emailDetailProgram(FIXTURE_ACTOR, randomUUID()),
    )
    expect(exit._tag).toBe('Failure')
  })
})
