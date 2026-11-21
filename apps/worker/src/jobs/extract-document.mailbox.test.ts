import { createHash, randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, document, integration } from '@spaces/db/schema'
import { renderMessage } from '@spaces/sdk/testing'
import { QUEUES } from '@spaces/core/queue/names'
import { storage } from '@spaces/core/writes/storage'
import {
  AttachmentUnavailable,
  MailAttachments,
  attachmentIn,
} from '#web/lib/arrival/mail-attachments'
import { logSyncedEmailProgram } from '#web/lib/arrival/synced'
import { minimalPdf } from '#web/test/minimal-pdf'
import { enqueued } from '#web/test/queue-stub'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { JobContext } from '../run-job'
import {
  ExtractionStore,
  extractDocument,
  mailBytesOf,
} from './extract-document'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * End to end, bar Gmail itself: a synced email's PDF arrives with no
 * bytes, and the ordinary extract job reads it from the mailbox, stores its
 * text and hands it to the embed lane, and stores no file. The mailbox is a
 * stub answering the message's own rendered bytes; everything else is the
 * live store.
 */

const mailbox = new Map<string, Buffer>()

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

let gmail = ''

beforeEach(async () => {
  enqueued.length = 0
  mailbox.clear()
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: `anish+${randomUUID().slice(0, 6)}@fund.example`,
        tokensEnc: Buffer.from('never read'),
        scopes: ['openid', 'email', 'gmail.readonly'],
        createdAt: new Date(Date.now() - 3_600_000),
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

describe('a synced PDF attachment', () => {
  it('is read from its mailbox: text and the embed lane, no stored file', async () => {
    const phrase = `Atmos flight hours ${randomUUID().slice(0, 8)}`
    const deck = minimalPdf(phrase)
    const sha = createHash('sha256').update(deck).digest('hex')
    const id = `m${randomUUID().replaceAll('-', '').slice(0, 15)}`
    const raw = Buffer.from(
      renderMessage({
        id,
        labelIds: ['INBOX'],
        receivedAt: Date.now() - 60_000,
        messageId: `${randomUUID()}@atmos.example`,
        from: 'Jane Founder <jane@atmos.example>',
        to: ['anish@fund.example'],
        cc: [],
        subject: 'Investor deck',
        body: 'Deck attached.',
        attachments: [
          {
            filename: 'Atmos deck.pdf',
            mime: 'application/pdf',
            content: deck.toString('latin1'),
          },
        ],
      }),
    )
    mailbox.set(id, raw)
    const filed = await Effect.runPromise(
      logSyncedEmailProgram(
        { integrationId: gmail },
        {
          providerMessageId: id,
          raw,
          receivedAt: new Date(Date.now() - 60_000),
          labels: ['Inbox'],
        },
      ),
    )
    expect(filed.outcome).toBe('created')
    const doc = (
      await db
        .select({ id: document.entityId, blobSha: document.blobSha })
        .from(document)
        .where(eq(document.filename, 'Atmos deck.pdf'))
    ).at(0)
    if (doc === undefined) throw new Error('no document')
    expect(doc.blobSha).toBeNull()

    const real = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* ExtractionStore
        }),
        ExtractionStore.layer,
      ),
    )
    const store = Layer.succeed(
      ExtractionStore,
      ExtractionStore.of({
        ...real,
        mailBytes: (documentId) =>
          mailBytesOf(documentId).pipe(Effect.provide(stubMailbox)),
      }),
    )
    enqueued.length = 0
    await Effect.runPromise(
      extractDocument.run({ documentId: doc.id }).pipe(
        Effect.provide(store),
        Effect.provideService(
          JobContext,
          JobContext.of({
            queue: QUEUES.extractDocument,
            jobId: `test-${id}`,
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
      ),
    )

    const after = (
      await db
        .select({
          blobSha: document.blobSha,
          extractionStatus: document.extractionStatus,
          extractedText: document.extractedText,
        })
        .from(document)
        .where(eq(document.entityId, doc.id))
    ).at(0)
    expect(after?.extractionStatus).toBe('done')
    expect(after?.extractedText).toContain(phrase)
    expect(after?.blobSha).toBeNull()
    expect(await storage().exists(sha)).toBe(false)
    expect(enqueued.map((e) => e.name)).toContain(QUEUES.embedDocument)
  })
})
