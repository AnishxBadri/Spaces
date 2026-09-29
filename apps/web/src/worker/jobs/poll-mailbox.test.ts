import { createHash, randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { db } from '@spaces/db'
import {
  document,
  entityAlias,
  interaction,
  jobRun,
  link,
  mailbox,
} from '@spaces/db/schema'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { FakeImapServer } from '#/test/fake-imap'
import { minimalPdf } from '#/test/minimal-pdf'
import { enqueued } from '#/test/queue-stub'
import { truncateAndReseed } from '#/test/reseed'
import { storage } from '@spaces/core/writes/storage'
import { searchAllProgram } from '#/lib/search/query'
import {
  MAILBOX,
  bcc,
  bccHeaders,
  fillerBytes,
  withParts,
} from '#/lib/arrival/fixtures'
import { MailSchedule, mailScheduleLayer } from '#/lib/arrival/schedule'
import type { ScheduleClient } from '#/lib/arrival/schedule'
import { saveMailboxProgram } from '#/lib/arrival/settings'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { JobContext, runJob } from '../run-job'
import type { JobHost, JobOutcome } from '../run-job'
import { ExtractionStore, extractDocument } from './extract-document'
import { pollMailbox, syncMailScheduleProgram } from './poll-mailbox'

/**
 * SPA-56, the pg-boss half of `mail.poll`: the job through `runJob`, so the
 * `job_run` row it leaves is the real one, and the schedule sync the worker
 * runs at boot, over a recording stand-in for pg-boss.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The upload ceiling, lowered for this file (SPA-115): "refused mid-stream"
 * is a claim about the intake meter, and 250 MB of base64 through the fake
 * IMAP server would test the fixture, not the meter. Every module reading the
 * constant — `lib/documents/intake.ts` among them — sees this value; nothing
 * in the intake itself changes.
 */
vi.mock('@spaces/core/documents', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MAX_UPLOAD_BYTES: 256 * 1024,
}))

const PASSWORD = 'app-password-1234'
let server: FakeImapServer
let port = 0

const quietSchedule = Layer.succeed(
  MailSchedule,
  MailSchedule.of({ sync: () => Effect.void }),
)

beforeEach(async () => {
  await truncateAndReseed()
  server = new FakeImapServer({ user: MAILBOX, password: PASSWORD })
  port = await server.start()
})

afterEach(async () => {
  await server.stop()
})

async function configure(password: string, cadenceMinutes = 5) {
  await Effect.runPromise(
    saveMailboxProgram(FIXTURE_ACTOR.id, {
      address: MAILBOX,
      host: '127.0.0.1',
      port,
      useTls: false,
      folder: 'INBOX',
      cadenceMinutes,
      password,
    }),
  )
}

const seedMail = bcc({
  messageId: 'seed-1@acme.io',
  from: 'Jane Founder <jane@acme.io>',
  to: 'Anish <anish@fund.example>',
  subject: 'Seed round',
})

describe('mail.poll through runJob', () => {
  it('writes one job_run row per poll, queue mail.poll, carrying the message count', async () => {
    await configure(PASSWORD)
    server.deliver(seedMail)
    server.deliver(
      bcc({
        messageId: 'ooo-2@acme.io',
        from: 'jane@acme.io',
        to: MAILBOX,
        subject: 'Out of office',
        extra: 'Auto-Submitted: auto-replied',
      }),
    )
    const box = (await db.select().from(mailbox)).at(0)
    const host = recordingHost()
    await runJob(pollMailbox, { host, layer: quietSchedule })([
      fakeJob({ mailboxId: box?.id, integrationId: box?.integrationId }),
    ])

    expect(host.calls).toEqual(['complete'])
    const runs = await db
      .select()
      .from(jobRun)
      .where(eq(jobRun.queue, 'mail.poll'))
    expect(runs).toHaveLength(1)
    expect(runs.at(0)).toMatchObject({
      status: 'succeeded',
      integrationId: box?.integrationId,
      error: null,
      summary:
        'fetched 2 · written 1 · duplicate 0 · refused 1 (auto-submitted 1)',
    })
  })

  it('a refused login fails the attempt terminally, in the server’s words, with no pg-boss retry', async () => {
    await configure('the-wrong-password')
    server.deliver(seedMail)
    const host = recordingHost()
    await runJob(pollMailbox, { host, layer: quietSchedule })([fakeJob({})])

    // `failTerminal`, never `fail`: the backoff is the mailbox row's, and a
    // pg-boss retry seconds later would be the tight loop it exists to stop.
    expect(host.calls).toEqual(['failTerminal'])
    const run = (
      await db.select().from(jobRun).where(eq(jobRun.queue, 'mail.poll'))
    ).at(0)
    expect(run?.status).toBe('failed')
    expect(run?.summary).toBeNull()
    expect(run?.error).toBe(
      'permanent: Login refused: [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
    )
    expect((await db.select().from(mailbox)).at(0)?.status).toBe('error')
  })
})

// A third of a megabyte through IMAP, mailparser and the intake meter, then
// an extraction: seconds on a loaded box, not the 5s default.
describe(
  'forwarded attachments through the job (SPA-115)',
  { timeout: 30_000 },
  () => {
    it('an attachment over MAX_UPLOAD_BYTES is refused mid-stream, the reason on job_run, and the rest of the message lands', async () => {
      expect(MAX_UPLOAD_BYTES).toBe(256 * 1024)
      await configure(PASSWORD)
      const deck = minimalPdf(`Acme seed deck ${randomUUID()}`)
      const deckSha = sha(deck)
      const huge = fillerBytes(MAX_UPLOAD_BYTES + 100_000)
      server.deliver(
        withParts({
          headers: bccHeaders({
            messageId: 'room-1@acme.io',
            from: 'Jane Founder <jane@acme.io>',
            to: 'Anish <anish@fund.example>',
            subject: 'Data room',
          }),
          text: 'Deck and the data room export.',
          parts: [
            {
              filename: 'data-room.zip',
              mime: 'application/zip',
              content: huge,
              disposition: 'attachment',
            },
            {
              filename: 'Acme seed.pdf',
              mime: 'application/pdf',
              content: deck,
              disposition: 'attachment',
            },
          ],
        }),
      )
      const box = (await db.select().from(mailbox)).at(0)
      const host = recordingHost()
      await runJob(pollMailbox, { host, layer: quietSchedule })([
        fakeJob({ mailboxId: box?.id, integrationId: box?.integrationId }),
      ])

      expect(host.calls).toEqual(['complete'])
      const run = (
        await db.select().from(jobRun).where(eq(jobRun.queue, 'mail.poll'))
      ).at(0)
      expect(run?.status).toBe('succeeded')
      expect(run?.summary).toBe(
        'fetched 1 · written 1 · duplicate 0 · refused 0 · ' +
          'attachments filed 1, unfiled 0, skipped 0, refused 1 ' +
          `(data-room.zip: Larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit)`,
      )

      // The message landed, and so did its other attachment.
      expect(await db.select().from(interaction)).toHaveLength(1)
      const docs = await db
        .select({ filename: document.filename, blobSha: document.blobSha })
        .from(document)
      expect(docs).toEqual([{ filename: 'Acme seed.pdf', blobSha: deckSha }])
      // Nothing of the refused part was stored.
      expect(await storage().exists(sha(huge))).toBe(false)
      await storage().delete(deckSha)
    })

    it('a forwarded PDF reaches extraction done through the existing job, and Cmd-K finds a phrase inside it', async () => {
      await configure(PASSWORD)
      const phrase = `Ohmium electrolyser stack ${randomUUID().slice(0, 8)}`
      const deck = minimalPdf(phrase)
      server.deliver(
        withParts({
          headers: bccHeaders({
            messageId: 'deck-9@ohmium.dev',
            from: 'Arne Founder <arne@ohmium.dev>',
            to: 'Anish <anish@fund.example>',
            subject: 'Ohmium Series A deck',
          }),
          text: 'Deck attached.',
          parts: [
            {
              filename: 'Ohmium Series A.pdf',
              mime: 'application/pdf',
              content: deck,
              disposition: 'attachment',
            },
          ],
        }),
      )
      enqueued.length = 0
      await runJob(pollMailbox, {
        host: recordingHost(),
        layer: quietSchedule,
      })([fakeJob({})])

      const doc = (await db.select().from(document)).at(0)
      if (!doc) throw new Error('no document')
      expect(enqueued).toEqual([
        { name: QUEUES.extractDocument, data: { documentId: doc.entityId } },
      ])

      // Exactly what `runJob` would run, with no change to extract-document.
      await Effect.runPromise(
        Effect.provide(
          Effect.provideService(
            extractDocument.run({ documentId: doc.entityId }),
            JobContext,
            JobContext.of({
              queue: QUEUES.extractDocument,
              jobId: 'test-spa115',
              attempt: 1,
              isFinalAttempt: true,
            }),
          ),
          ExtractionStore.layer,
        ),
      )
      const extracted = (
        await db
          .select({
            status: document.extractionStatus,
            kind: document.kind,
          })
          .from(document)
          .where(eq(document.entityId, doc.entityId))
      ).at(0)
      expect(extracted).toEqual({ status: 'done', kind: 'other' })

      const company = (
        await db
          .select({ id: entityAlias.entityId })
          .from(entityAlias)
          .where(
            and(
              eq(entityAlias.kind, 'domain'),
              eq(entityAlias.valueNorm, 'ohmium.dev'),
            ),
          )
      ).at(0)
      const hits = await Effect.runPromise(
        searchAllProgram({ userId: FIXTURE_ACTOR.id, q: phrase }),
      )
      const hit = hits.find((h) => h.id === doc.entityId)
      expect(hit?.snippet).toContain(phrase.split(' ').at(-1))
      expect(hit?.parent?.id).toBe(company?.id)
      const edges = await db
        .select({ to: link.toEntityId })
        .from(link)
        .where(eq(link.fromEntityId, doc.entityId))
      expect(edges).toEqual([{ to: company?.id }])

      if (doc.blobSha) await storage().delete(doc.blobSha)
    })
  },
)

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('the schedule the worker syncs at boot', () => {
  it('with no mailbox row, schedules nothing and clears any stale schedule', async () => {
    const { calls, client } = recorder()
    await Effect.runPromise(
      syncMailScheduleProgram().pipe(Effect.provide(mailScheduleLayer(client))),
    )
    expect(calls).toEqual([{ op: 'unschedule', name: 'mail.poll' }])
  })

  it('with a mailbox row, schedules mail.poll from cadence_minutes', async () => {
    await configure(PASSWORD, 15)
    const box = (await db.select().from(mailbox)).at(0)
    const { calls, client } = recorder()
    await Effect.runPromise(
      syncMailScheduleProgram().pipe(Effect.provide(mailScheduleLayer(client))),
    )
    expect(calls).toEqual([
      {
        op: 'schedule',
        name: 'mail.poll',
        cron: '*/15 * * * *',
        data: { mailboxId: box?.id, integrationId: box?.integrationId },
      },
    ])
  })

  it('logs a failed sync rather than failing the boot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const layer = mailScheduleLayer({
      schedule: () => Promise.reject(new Error('pgboss down')),
      unschedule: () => Promise.reject(new Error('pgboss down')),
    })
    await expect(
      Effect.runPromise(syncMailScheduleProgram().pipe(Effect.provide(layer))),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

function recorder() {
  const calls: Array<{
    op: string
    name: string
    cron?: string
    data?: object
  }> = []
  const client: ScheduleClient = {
    schedule: (name, cron, data) => {
      calls.push(
        data === undefined
          ? { op: 'schedule', name, cron }
          : { op: 'schedule', name, cron, data },
      )
      return Promise.resolve()
    },
    unschedule: (name) => {
      calls.push({ op: 'unschedule', name })
      return Promise.resolve()
    },
  }
  return { calls, client }
}

function recordingHost(): JobHost & { calls: Array<string> } {
  const calls: Array<string> = []
  const record =
    (name: string) => async (_q: string, _id: string, _o: JobOutcome) => {
      calls.push(name)
    }
  return {
    calls,
    complete: record('complete'),
    fail: record('fail'),
    failTerminal: record('failTerminal'),
    send: async () => undefined,
  }
}

const epoch = new Date(0)

function fakeJob(data: object): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: 'mail.poll',
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 0,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: epoch,
    startedOn: epoch,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 604800,
    createdOn: epoch,
    completedOn: null,
    keepUntil: epoch,
    policy: 'singleton',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: '',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  }
}
