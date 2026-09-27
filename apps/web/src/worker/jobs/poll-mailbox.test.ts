import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { db } from '@spaces/db'
import { jobRun, mailbox } from '@spaces/db/schema'
import { truncatePublicTables } from '@spaces/db/test-db'
import { FakeImapServer } from '#/test/fake-imap'
import { MAILBOX, bcc } from '#/lib/arrival/fixtures'
import { MailSchedule, mailScheduleLayer } from '#/lib/arrival/schedule'
import type { ScheduleClient } from '#/lib/arrival/schedule'
import { saveMailboxProgram } from '#/lib/arrival/settings'
import { FIXTURE_ACTOR, seedTestDatabase } from '../../../vitest.seed'
import { runJob } from '../run-job'
import type { JobHost, JobOutcome } from '../run-job'
import { pollMailbox, syncMailScheduleProgram } from './poll-mailbox'

/**
 * SPA-56, the pg-boss half of `mail.poll`: the job through `runJob`, so the
 * `job_run` row it leaves is the real one, and the schedule sync the worker
 * runs at boot, over a recording stand-in for pg-boss.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const PASSWORD = 'app-password-1234'
let server: FakeImapServer
let port = 0

const quietSchedule = Layer.succeed(
  MailSchedule,
  MailSchedule.of({ sync: () => Effect.void }),
)

beforeEach(async () => {
  await truncatePublicTables((text) => db.$client.query(text))
  const speak = console.log
  console.log = () => undefined
  try {
    await seedTestDatabase()
  } finally {
    console.log = speak
  }
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
